import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { featureFolder } from '../../scripts/runtime/portable/feature-folder.mjs';
import { projectDefaults } from '../../scripts/runtime/portable/project.mjs';
const digest = text => createHash('sha256').update(text).digest('hex');
async function fixture(t) {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'werk-folder-')));
  await mkdir(join(project, '.werk/worker'), { recursive: true }); await mkdir(join(project, 'features/_templates'), { recursive: true }); await mkdir(join(project, 'features/_results'));
  const config = { schemaVersion: 1, features: { directory: 'features', provider: 'openai-api', pollMs: 500 } };
  const raw = JSON.stringify(config) + '\n';
  await writeFile(join(project, '.werk/worker.json'), raw, { mode: 0o600 }); await writeFile(join(project, '.werk/worker-project.json'), JSON.stringify({ schemaVersion: 1, port: 4100 }), { mode: 0o600 });
  await writeFile(join(project, 'features/request.md'), 'request bytes\n'); await writeFile(join(project, 'features/_templates/feature-request.md'), 'custom template\n'); await writeFile(join(project, 'features/_results/result.md'), 'result bytes\n'); await writeFile(join(project, 'features/_worker-owner.json'), '{"owner":"same-worker"}');
  t.after(() => rm(project, { recursive: true, force: true }));
  return { project, config, raw, call: (action, path) => featureFolder(action, { 'project-dir': project, ...(path ? { path } : {}) }) };
}
test('folder configuration previews without writes and relocates requests, results and templates for native/Docker', async t => {
  const f = await fixture(t); assert.equal((await f.call('get')).path, 'features');
  const plan = await f.call('plan', 'requests/feature requests'); assert.equal(plan.changed, true); assert.equal(plan.blocked, false);
  assert.equal(await readFile(join(f.project, '.werk/worker.json'), 'utf8'), f.raw); await assert.rejects(readFile(join(f.project, 'requests/feature requests/request.md')));
  await f.call('set', 'requests/feature requests'); const current = await f.call('get'); assert.equal(current.path, 'requests/feature requests');
  assert.equal(await readFile(join(current.directory, 'request.md'), 'utf8'), 'request bytes\n'); assert.equal(await readFile(join(current.directory, '_templates/feature-request.md'), 'utf8'), 'custom template\n'); assert.equal(await readFile(join(current.directory, '_results/result.md'), 'utf8'), 'result bytes\n');
  const config = JSON.parse(await readFile(current.configuration, 'utf8')); assert.equal(config.features.provider, 'openai-api'); assert.equal(config.features.pollMs, 500); assert.equal(config.features.directory, current.path);
  assert.equal((await projectDefaults({ 'project-dir': f.project }, true)).config, current.configuration);
  assert.equal((await f.call('set', current.path)).changed, false); await assert.rejects(readFile(join(f.project, '.werk/worker.lock')), { code: 'ENOENT' });
});
test('folder changes refuse active workers, existing destinations, reserved paths, overlaps and symlinks', async t => {
  const f = await fixture(t); await writeFile(join(f.project, '.werk/worker/worker.lock'), 'active');
  assert.equal((await f.call('plan', 'requests')).blocked, true); await assert.rejects(f.call('set', 'requests'), /Stop the worker/); await rm(join(f.project, '.werk/worker/worker.lock'));
  await mkdir(join(f.project, 'existing')); await writeFile(join(f.project, 'existing/keep.md'), 'untouched');
  for (const path of ['existing', '../outside', '.werk/requests', 'bin/features', 'features/nested']) await assert.rejects(f.call('set', path));
  if (process.platform !== 'win32') { await symlink(join(f.project, 'existing'), join(f.project, 'alias')); await assert.rejects(f.call('set', 'alias/requests'), /symlink/); }
  assert.equal(await readFile(join(f.project, '.werk/worker.json'), 'utf8'), f.raw); assert.equal(await readFile(join(f.project, 'existing/keep.md'), 'utf8'), 'untouched');
});
test('an interrupted move blocks project startup and can finish without losing data', async t => {
  const f = await fixture(t), next = JSON.stringify({ ...f.config, features: { ...f.config.features, directory: 'requests' } }, null, 2) + '\n';
  await writeFile(join(f.project, '.werk/feature-folder-change.json'), JSON.stringify({ schemaVersion: 1, from: 'features', to: 'requests', before: digest(f.raw), after: digest(next) }), { mode: 0o600 });
  await rename(join(f.project, 'features'), join(f.project, 'requests'));
  await assert.rejects(projectDefaults({ 'project-dir': f.project }, true), /incomplete/);
  assert.equal((await f.call('get')).pendingChange.to, 'requests'); await assert.rejects(f.call('set', 'different'), /interrupted/);
  await f.call('set', 'requests'); assert.equal((await f.call('get')).pendingChange, null); assert.equal(await readFile(join(f.project, 'requests/request.md'), 'utf8'), 'request bytes\n');
  await projectDefaults({ 'project-dir': f.project }, true);
});
