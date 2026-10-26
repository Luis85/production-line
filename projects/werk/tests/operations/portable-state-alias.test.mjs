import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stateDirectory } from '../../scripts/runtime/portable/lifecycle.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url)), exec = promisify(execFile);
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('WERK_')));
async function fixture(t) {
  const outer = await realpath(await mkdtemp(join(tmpdir(), 'werk-state-alias-'))), app = join(outer, 'app'), parent = join(outer, 'private-parent'), alias = join(outer, 'parent-alias'), outside = join(outer, 'outside');
  await mkdir(parent, { mode: 0o700 }); await mkdir(outside, { mode: 0o700 });
  try { await symlink(parent, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { await rm(outer, { recursive: true, force: true }); if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Directory junction creation unavailable'); return; } throw error; }
  await cp(join(project, 'bin/apps/worker'), app, { recursive: true });
  const entry = join(app, 'cli.mjs');
  const states = new Set();
  async function invoke(...args) {
    try { const result = await exec(process.execPath, [entry, ...args], { cwd: outer, env: environment, timeout: 40000, maxBuffer: 1048576 }); return { code: 0, ...result }; }
    catch (error) { if (!Number.isInteger(error.code)) throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  }
  async function cli(...args) { const result = await invoke(...args); assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout); }
  async function start(state) { states.add(state); return cli('start', '--state-dir', state, '--port', '0'); }
  t.after(async () => { for (const state of states) await invoke('stop', '--state-dir', state).catch(() => {}); await rm(outer, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  async function api(started, path, body) {
    const token = (await readFile(started.credentialsFile, 'utf8')).trim();
    const response = await fetch(started.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 200); return response.json();
  }
  async function create(started, id) {
    await api(started, '/api/settings', { board: { paused: true }, provider: { id: 'openai-api', apiKey: 'fixture-do-not-call', model: 'fixture' } });
    return api(started, '/api/tasks', { action: 'create', id, title: 'Alias startup request', provider: 'openai-api', message: 'Retain a Markdown request without executing a provider.' });
  }
  return { outer, app, parent, alias, outside, invoke, cli, start, api, create };
}

test('copied worker canonicalizes an ancestor state alias and saves default Markdown tracking across restart', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const aliased = join(f.alias, 'new', 'worker'), canonical = join(f.parent, 'new', 'worker');
  const first = await f.start(aliased);
  const tracking = await f.api(first, '/api/feature-tracking');
  assert.equal(tracking.error, null, 'A supported parent alias must not leave task Markdown unavailable.');
  assert.equal(first.stateDirectory, canonical); assert.equal(tracking.directory, join(canonical, 'feature-requests'));
  const created = await f.create(first, 'alias-request'); assert.equal(created.featureTracking.error, null); assert.ok(created.session.featureRequest.path);
  assert.match(await readFile(created.session.featureRequest.path, 'utf8'), /Retain a Markdown request/);
  assert.equal((await f.cli('status', '--state-dir', aliased)).runId, first.runId);
  await f.cli('stop', '--state-dir', aliased);
  const restarted = await f.start(canonical), restored = await f.api(restarted, '/api/tasks', { action: 'get', id: created.session.id });
  assert.equal(restored.session.featureRequest.path, created.session.featureRequest.path); assert.equal(restored.featureTracking.error, null);
  assert.equal((await f.cli('status', '--state-dir', aliased)).runId, restarted.runId);
});

test('canonicalizing parents still rejects a symlink at the selected state directory', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const linked = join(f.parent, 'linked-state'); await symlink(f.outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(stateDirectory('worker', f.app, linked), /real private directory|symlink/);
  const result = await f.invoke('start', '--state-dir', linked, '--port', '0'); assert.equal(result.code, 2); assert.match(result.stderr, /real private directory|symlink/);
  assert.deepEqual(await readdir(f.outside), [], 'A target link must not cause writes through the link.');
});

test('canonicalizing parents does not follow managed tracking directory symlinks', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const state = join(f.parent, 'managed-child'); await mkdir(state, { mode: 0o700 });
  await symlink(f.outside, join(state, 'feature-requests'), process.platform === 'win32' ? 'junction' : 'dir');
  const started = await f.start(join(f.alias, 'managed-child')), created = await f.create(started, 'refused-child');
  assert.match(created.featureTracking.error, /unavailable|could not be saved/); assert.equal(created.session.featureRequest, undefined);
  assert.deepEqual(await readdir(f.outside), [], 'A managed tracking link must never be written through.');
});
