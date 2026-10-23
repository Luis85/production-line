import { WorkerSessions } from './application-fixtures.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerRunJournal } from '../../src/worker/dist/worker/infrastructure/journal/local-runs.js';
import { validateRunLineage } from '../../src/worker/dist/worker/application/run-evidence.js';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { providerCommand } from '../../src/worker/dist/worker/infrastructure/provider-process.js';
import { providerAuthenticationEnvironment, requireProviderAuthentication } from '../../src/worker/dist/worker/infrastructure/provider-authentication.js';
import { ProviderStatusChecks } from '../../src/worker/dist/worker/infrastructure/provider-status.js';
import { providerCapabilities } from '../../src/worker/dist/worker/application/provider-capabilities.js';
import { modelSelection, selectedConnection } from '../../src/worker/dist/worker/application/model-selection.js';
import { providerReady } from '../../src/worker/dist/worker/application/provider-contract.js';
import { modelFor, claudeArguments } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { prepareModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';

/** @param {import('node:test').TestContext} t @param {{close(): void | Promise<void>}[]} resources */
async function directory(t, resources = []) {
  const root = await mkdtemp(join(tmpdir(), 'werk-provider-auth-'));
  t.after(async () => {
    await Promise.all(resources.map(resource => resource.close()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return root;
}
test('old CLI settings require a billing choice; saved keys are retained privately and clearing never falls back', async t => {
  const root = await directory(t), initial = new WorkerSettings(root); await initial.init();
  const saved = JSON.parse(await readFile(join(root, 'workspace-settings.json'), 'utf8'));
  for (const provider of saved.providers) delete provider.authenticationMode;
  saved.providers.find(item => item.id === 'cursor-cli').apiKey = 'private-existing-key';
  await writeFile(join(root, 'workspace-settings.json'), JSON.stringify(saved));
  const migrated = new WorkerSettings(root); await migrated.init();
  for (const provider of migrated.publicView().providers) {
    assert.equal(provider.authenticationMode, provider.id.endsWith('-cli') ? 'legacy' : 'api-key');
    if (provider.id.endsWith('-cli')) { assert.equal(provider.configured, false); assert.equal(provider.authenticationConfigured, false); }
  }
  assert.doesNotMatch(JSON.stringify(migrated.publicView()), /private-existing-key/);
  await migrated.update({ provider: { id: 'cursor-cli', executable: process.execPath, authenticationMode: 'api-key' } });
  assert.equal(providerReady(migrated.provider('cursor-cli')), true);
  await migrated.update({ provider: { id: 'cursor-cli', clearApiKey: true } });
  assert.equal(migrated.provider('cursor-cli').authenticationMode, 'api-key');
  assert.equal(providerReady(migrated.provider('cursor-cli')), false);
  await assert.rejects(migrated.update({ provider: { id: 'openai-api', authenticationMode: 'cli-account' } }));
  const restarted = new WorkerSettings(root); await restarted.init();
  assert.equal(restarted.provider('cursor-cli').authenticationMode, 'api-key');
});

for (const [id, provider, key] of /** @type {const} */ ([['codex-cli', 'codex', 'CODEX_API_KEY'], ['claude-cli', 'claude', 'ANTHROPIC_API_KEY'], ['cursor-cli', 'cursor', 'CURSOR_API_KEY']])) {
  test(`${id} account mode excludes inherited API credentials; API mode uses only its saved key`, async t => {
    const root = await directory(t); const previous = process.env[key]; process.env[key] = 'private-inherited-key';
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    const base = { id, executable: process.execPath, model: '', apiKey: 'private-selected-key' };
    const script = `process.stdout.write(JSON.stringify({present:!!process.env.${key},selected:process.env.${key}==='private-selected-key'}))`;
    for (const mode of /** @type {const} */ (['cli-account', 'api-key'])) {
      const output = await providerCommand(process.execPath, ['-e', script], root, t.signal, undefined, true, provider, undefined,
        providerAuthenticationEnvironment({ ...base, authenticationMode: mode }));
      assert.deepEqual(JSON.parse(output.toString()), { present: mode === 'api-key', selected: mode === 'api-key' });
    }
    assert.throws(() => providerAuthenticationEnvironment({ ...base, apiKey: '', authenticationMode: 'api-key' }), { code: 'authentication' });
    assert.throws(() => providerAuthenticationEnvironment({ ...base, authenticationMode: 'legacy' }), { code: 'authentication' });
    const accepted = modelSelection({ ...base, authenticationMode: 'cli-account' });
    assert.equal(accepted.authenticationMode, 'cli-account');
    assert.throws(() => selectedConnection({ ...base, authenticationMode: 'api-key' }, accepted), { code: 'conflict' });
    assert.throws(() => selectedConnection({ ...base, authenticationMode: 'api-key' }, { provider: id, model: '', effort: 'default' }), { code: 'conflict' });
    const model = modelFor({ ...base, authenticationMode: 'cli-account' }, root);
    if (id !== 'codex-cli' || process.platform !== 'win32') {
      assert.ok(model);
      assert.equal(prepareModelRequest(model, []).provider.authenticationMode, 'cli-account');
    }
  });
}

test('Claude account billing rejects a Console/API login before inference; diagnostics expose the mismatch', { skip: process.platform === 'win32' }, async t => {
  const root = await directory(t), executable = join(root, 'claude-fixture');
  await writeFile(executable, '#!' + process.execPath + '\n' + `const a=process.argv.slice(2);if(a.includes('--version'))console.log('2.1.277');else if(a.join(' ')==='auth status')console.log(JSON.stringify({loggedIn:true,authMethod:'api_key',apiKey:'private-key'}));else process.exit(99);`, { mode: 0o700 });
  const connection = { id: /** @type {const} */ ('claude-cli'), executable, model: '', apiKey: '', authenticationMode: /** @type {const} */ ('cli-account') };
  await assert.rejects(requireProviderAuthentication(connection, t.signal), { code: 'authentication' });
  const checks = new ProviderStatusChecks(); t.after(() => checks.close());
  const status = await checks.check(connection);
  assert.equal(status.authentication, 'unknown'); assert.equal(status.available, false); assert.equal(status.version, '2.1.277');
  assert.doesNotMatch(JSON.stringify(status), /private-key/);
  const args = claudeArguments('', 'prompt.md', undefined, undefined, 'cli-account');
  assert.equal(JSON.parse(args[args.indexOf('--settings') + 1]).forceLoginMethod, 'claudeai');
});

test('accepted billing survives restart; changing it holds continuation while keeping transcripts inspectable', async t => {
  const resources = [];
  const root = await directory(t, resources), settings = new WorkerSettings(root); await settings.init();
  const model = () => ({ async reply() { return 'Saved fixture answer'; } });
  const first = WorkerSessions(root, settings, model); resources.push(first); await first.init();
  await first.start('Remember this feature request');
  while (first.busy) { t.signal.throwIfAborted(); await delay(10); }
  assert.equal(first.current.selection.authenticationMode, 'cli-account');
  await first.close();
  const resumed = WorkerSessions(root, settings, model); resources.push(resumed); await resumed.init();
  assert.equal(resumed.detail('default').chat.messages.at(-1).text, 'Saved fixture answer');
  await resumed.updateProviders(() => settings.update({ provider: { id: 'codex-cli', authenticationMode: 'api-key', apiKey: 'private-fixture-key' } }));
  assert.equal(resumed.detail('default').chat.messages.at(-1).text, 'Saved fixture answer');
  assert.match(resumed.current.continuationBlockedReason, /authentication and billing changed/);
  await assert.rejects(resumed.start('Do not silently change billing'), { code: 'conflict' });
  assert.doesNotMatch(JSON.stringify(resumed.view()), /private-fixture-key/);
});

test('billing provenance remains in the durable run and cannot change for delegated work', async t => {
  const resources = [];
  const root = await directory(t, resources), journal = new WorkerRunJournal(root); resources.push(journal); await journal.init();
  const run = await journal.begin({ sessionId: 'session', taskId: 'task', kind: 'local', title: 'Fixture', provider: 'claude-cli', model: 'fixture', authenticationMode: 'cli-account' });
  await journal.start(run.id);
  const saved = journal.get(run.id); assert.equal(saved.authenticationMode, 'cli-account');
  const child = { sessionId: 'child', taskId: 'task', kind: /** @type {const} */ ('local'), title: 'Fixture', provider: 'claude-cli', model: 'fixture', parentRunId: run.id, parentSessionId: 'session', delegationId: 'part' };
  assert.throws(() => validateRunLineage({ ...child, authenticationMode: 'api-key' }, saved), { code: 'conflict' });
  assert.doesNotThrow(() => validateRunLineage({ ...child, authenticationMode: 'cli-account' }, saved));
  await journal.finish(run.id, 'completed');
});

test('capabilities preserve provider-native Cursor authority and truthful remote cancellation/usage limits', () => {
  const cursor = providerCapabilities('cursor-cli'), claude = providerCapabilities('claude-cli');
  assert.equal(cursor.permissions, 'provider_native'); assert.equal(cursor.usage, 'unavailable');
  assert.equal(cursor.loadedExtensions, 'provider_configuration_not_enumerated');
  assert.equal(claude.permissions, 'worker_grants'); assert.equal(claude.continuation, 'provider_session');
  assert.equal(claude.interruption, 'await_local_process_tree'); assert.equal(claude.remoteCancellation, 'not_confirmed');
  assert.deepEqual(providerCapabilities('openai-api').authenticationModes, ['api-key']);
});


test('remote session restart recovers upstream billing provenance without inferring local account defaults', async t => {
  const resources = [];
  const root = await directory(t, resources), settings = new WorkerSettings(root); await settings.init();
  let dispatches = 0;
  const model = () => ({ async reply() { dispatches++; return 'Unexpected model invocation.'; } });
  const first = WorkerSessions(root, settings, model); resources.push(first); await first.init();
  await first.ensureTask('upstream-task', 'orchestrator', 'Accepted remote request', 'codex-cli');
  assert.equal(first.detail('upstream-task').session.selection.authenticationMode, 'cli-account');
  const accepted = first.requests.ensure({ owner: { sessionId: 'upstream-task', rootTurnId: 'remote-turn', taskId: 'upstream-task' },
    provider: { id: 'codex-cli', model: '', instruction: '' }, input: { kind: 'chat', title: 'Accepted remote request', message: 'Inspect the retained upstream result.' } });
  await first.close();
  const restarted = WorkerSessions(root, settings, model); resources.push(restarted); await restarted.init();
  assert.deepEqual(restarted.detail('upstream-task').session.selection, { provider: 'codex-cli', model: '', effort: 'default' });
  assert.equal(restarted.requests.get(accepted.id).provider.authenticationMode, undefined);
  assert.match(restarted.detail('upstream-task').session.continuationBlockedReason, /authentication and billing changed/);
  assert.equal(settings.provider('codex-cli').authenticationMode, 'cli-account');
  assert.equal(dispatches, 0, 'Opening upstream history cannot imply authority to execute under a local billing mode.');
});
