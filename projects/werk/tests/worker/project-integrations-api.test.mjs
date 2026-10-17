import { workerStatus } from '../helpers/worker-status.mjs';
import { testListeningAddress } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { statusServer } from '../../src/worker/dist/worker/status/server.js';
async function fixture(t, configured = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk-integrations-http-'))), state = join(root, '.state'); await mkdir(state);
  const journal = new SnapshotJournal(state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
  const current = workerStatus(), workspace = new WorkerWorkspace({ stateDir: state, ...(configured ? { integrationProjectDir: root } : {}), pollMs: 1000, timeoutMs: 60000 }, journal, () => current); await workspace.init();
  const server = await statusServer(() => current, '127.0.0.1', 0, undefined, workspace);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await workspace.close(); await journal.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + testListeningAddress(server).port, token = (await readFile(join(state, 'webview-token'), 'utf8')).trim(), headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  return { root, base, headers, get: (authorized = true) => fetch(base + '/api/integrations', { headers: authorized ? headers : {} }), post: body => fetch(base + '/api/integrations', { method: 'POST', headers, body: JSON.stringify(body) }) };
}
test('integration HTTP inspection is authenticated and read-only; guarded apply preserves operator changes', async t => {
  const f = await fixture(t); assert.equal((await f.get(false)).status, 401);
  const plan = await (await f.get()).json(); assert.equal(plan.enabled, true); assert.equal(plan.projectDirectory, f.root); assert.equal(plan.canApply, true); assert.equal(plan.files.length, 3); assert.ok(plan.files.every(file => file.state === 'missing'));
  await assert.rejects(readFile(join(f.root, '.claude/skills/werk-worker/SKILL.md')), { code: 'ENOENT' });
  assert.equal((await f.post({ action: 'plan', projectDirectory: '/tmp/arbitrary' })).status, 400); assert.equal((await f.post({ action: 'apply' })).status, 400);
  const first = await f.post({ action: 'apply', expectedPlan: plan.planId }); assert.equal(first.status, 200);
  const synced = await first.json(); assert.equal(synced.enabled, true); assert.equal(synced.applied, true); assert.equal(synced.written.length, 3); assert.ok(synced.files.every(file => file.state === 'current'));
  const target = join(f.root, '.codex/werk-worker.md'); await writeFile(target, 'Operator owned content\n');
  assert.equal((await f.post({ action: 'apply', expectedPlan: synced.planId })).status, 409);
  const conflict = await (await f.post({ action: 'plan' })).json(); assert.equal(conflict.canApply, false); assert.equal(conflict.files.find(file => file.path === '.codex/werk-worker.md').state, 'conflict');
  assert.equal((await f.post({ action: 'apply', expectedPlan: conflict.planId })).status, 409); assert.equal(await readFile(target, 'utf8'), 'Operator owned content\n'); assert.ok(conflict.files.every(file => !file.content.includes('Operator owned content')));
});
test('integration HTTP cannot use cwd as an unconfigured mutation target', async t => {
  const f = await fixture(t, false); const result = await (await f.get()).json(); assert.equal(result.enabled, false); assert.match(result.reason, /configured project/);
  assert.equal((await f.post({ action: 'apply', expectedPlan: 'a'.repeat(64) })).status, 409);
  const capabilities = await (await fetch(f.base + '/api/capabilities', { headers: f.headers })).json(); assert.equal(capabilities.projectIntegrations.enabled, false); assert.equal(capabilities.projectIntegrations.automaticExecution, false);
});
