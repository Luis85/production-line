import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';
import { WorkerSessions } from './application-fixtures.mjs';
import { beforeSessionLoad } from './runtime-fixtures.mjs';

async function until(done) {
  for (let n = 0; n < 400; n++) { if (done()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('The deterministic session did not settle.');
}
/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-session-bootstrap-'));
  const settings = new WorkerSettings(directory); await settings.init();
  await settings.update({ defaultProvider: 'openai-api' });
  /** @type {import('../../src/worker/application/model-selection.js').ModelSelection[]} */
  const calls = [];
  /** @type {import('../../src/worker/infrastructure/workspace-services.js').WorkspaceProviderFactory} */
  const factory = connection => connection.model ? {
    capabilities: modelCapabilities,
    configuration: { id: connection.id, authenticationMode: connection.authenticationMode, model: connection.model, effort: connection.effort, instruction: '' },
    async reply() { throw Error('Structured execution required.'); },
    async execute(request) {
      const selection = { provider: connection.id, authenticationMode: connection.authenticationMode, model: connection.model, effort: connection.effort ?? 'default' };
      const saved = JSON.parse(await readFile(join(directory, 'sessions.json'), 'utf8'));
      assert.deepEqual(saved.records.find(record => record.id === request.session?.logicalSessionId).selection, selection);
      calls.push(selection);
      return { type: 'completed', text: 'Reviewed using the accepted model.' };
    },
  } : undefined;
  let sessions;
  async function open() { sessions = WorkerSessions(directory, settings, factory); await sessions.init(); }
  await open();
  t.after(async () => { await sessions.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory, settings, calls, get sessions() { return sessions; },
    async configure(model = 'configured-model', effort = 'low') { await settings.update({ provider: { id: 'openai-api', model, effort, apiKey: 'fixture-only' } }); },
    async restart() { await sessions.close(); await open(); },
    async settle() { await until(() => !sessions.busy); },
  };
}

test('unconfigured API placeholders open and restart without accepting a Feature Request', async t => {
  const f = await fixture(t);
  assert.equal(f.sessions.current.provider, 'openai-api');
  assert.equal(f.sessions.current.selection, undefined);
  await f.restart();
  await assert.rejects(f.sessions.start('Implement a feature'), /Choose a model/);
  assert.equal(f.sessions.requests.forSession('default'), undefined);
  assert.deepEqual(f.sessions.detail('default').chat.messages, []);
  assert.equal(f.sessions.current.selection, undefined);
  assert.deepEqual(f.calls, []);
});

test('first submission rebuilds the stale placeholder adapter and durably freezes its configured model', async t => {
  const f = await fixture(t), original = f.sessions.chat;
  // This durable settings update deliberately leaves the display-only adapter cached.
  await f.configure();
  await f.sessions.start('Review this feature'); await f.settle();
  const accepted = { provider: 'openai-api', authenticationMode: 'api-key', model: 'configured-model', effort: 'low' };
  assert.notEqual(f.sessions.chat, original);
  assert.deepEqual(f.sessions.current.selection, accepted);
  assert.deepEqual(f.calls, [accepted]);
  await f.sessions.updateProviders(() => f.configure('later-default', 'high'));
  await f.restart(); await f.sessions.start('Continue the same feature'); await f.settle();
  assert.deepEqual(f.calls, [accepted, accepted]);
  assert.deepEqual(f.sessions.current.selection, accepted);
});

test('display placeholders remain distinct from strict new admission and explicit selection validation', async t => {
  const f = await fixture(t);
  await f.sessions.action({ action: 'create', title: 'Configure later', provider: 'openai-api' });
  const placeholder = f.sessions.current.id;
  assert.equal(f.sessions.current.selection, undefined);
  await f.sessions.ensureTask('historical', 'local', 'Existing task history', 'openai-api');
  await f.restart();
  assert.equal(f.sessions.detail(placeholder).session.selection, undefined);
  assert.equal(f.sessions.detail('historical').session.selection, undefined);
  await assert.rejects(f.sessions.ensureTask('new-submission', 'chat', 'New feature', 'openai-api', 'a'.repeat(64)), /Choose a model/);
  await assert.rejects(f.sessions.action({ action: 'create', title: 'Explicit effort', provider: 'openai-api', effort: 'high' }), /Choose a model/);
  await assert.rejects(f.sessions.action({ action: 'create', title: 'Invalid effort', provider: 'openai-api', effort: 'invalid' }), /supported effort/);
  await f.sessions.ensureTask('legacy-snapshot', 'chat', 'Historical empty snapshot', 'openai-api', undefined, undefined, undefined, { provider: 'openai-api', model: '', effort: 'default' });
  await f.configure();
  await assert.rejects(f.sessions.start('Do not replace this snapshot with defaults', 'legacy-snapshot'), /Choose a model/);
  assert.equal(f.sessions.requests.forSession('legacy-snapshot'), undefined);
  assert.deepEqual(f.calls, []);
});

test('failed first-selection persistence admits no request and retry uses the new defaults', async t => {
  const f = await fixture(t); await f.configure();
  const original = f.sessions.chat, index = join(f.directory, 'sessions.json'), backup = join(f.directory, 'sessions-backup.json');
  await rename(index, backup); await mkdir(index);
  try { await assert.rejects(f.sessions.start('Must not be accepted before selection is durable')); }
  finally { await rm(index, { recursive: true }); await rename(backup, index); }
  assert.equal(f.sessions.current.selection, undefined);
  assert.equal(f.sessions.chat, original);
  assert.equal(f.sessions.requests.forSession('default'), undefined);
  assert.deepEqual(f.sessions.chat.snapshot().messages, []);
  assert.deepEqual(f.calls, []);
  await f.configure('retry-model', 'high');
  await f.sessions.start('Retry after repairing storage'); await f.settle();
  assert.deepEqual(f.calls, [{ provider: 'openai-api', authenticationMode: 'api-key', model: 'retry-model', effort: 'high' }]);
});

test('first-selection preparation excludes competing submissions and provider updates', async t => {
  const f = await fixture(t); await f.configure();
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  beforeSessionLoad(f.sessions, async () => { entered.resolve(undefined); await release.promise; });
  const first = f.sessions.start('Accept exactly one request');
  try {
    await entered.promise;
    await assert.rejects(f.sessions.start('Competing first message'), /Session change in progress/);
    await assert.rejects(f.sessions.updateProviders(() => f.configure('racing-model')), /Finish task changes/);
    assert.equal(f.sessions.requests.forSession('default'), undefined);
    assert.deepEqual(f.calls, []);
  } finally { release.resolve(undefined); await first; }
  await f.settle();
  assert.deepEqual(f.calls, [{ provider: 'openai-api', authenticationMode: 'api-key', model: 'configured-model', effort: 'low' }]);
});


test('an accepted selection cannot start while a same-tick provider update holds admission', async t => {
  const f = await fixture(t); await f.configure();
  await f.sessions.action({ action: 'create', title: 'Already selected', provider: 'openai-api' });
  const id = f.sessions.current.id, release = Promise.withResolvers();
  const starting = f.sessions.start('Must wait for the provider update', id);
  const updating = f.sessions.updateProviders(async () => { await release.promise; await f.configure('later-default', 'high'); });
  try {
    await assert.rejects(starting, /settings are being saved/);
    assert.equal(f.sessions.requests.forSession(id), undefined);
    assert.deepEqual(f.sessions.detail(id).chat.messages, []);
    assert.deepEqual(f.calls, []);
  } finally { release.resolve(undefined); await updating; }
  await f.sessions.start('Retry with the original selection', id); await f.settle();
  assert.deepEqual(f.calls, [{ provider: 'openai-api', authenticationMode: 'api-key', model: 'configured-model', effort: 'low' }]);
});
