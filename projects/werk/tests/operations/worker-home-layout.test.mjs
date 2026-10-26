import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, realpath, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withHomeRuntimeLock } from '../../scripts/runtime/home-update/guard.mjs';
import { inspectWorkerHome, selectWorkerHome } from '../../scripts/runtime/portable/home-layout.mjs';

const app = join(fileURLToPath(new URL('../../', import.meta.url)), 'bin', 'apps', 'worker');
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk Home layout ')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function legacy(home, child = '.werk/worker') {
  const state = join(home, child); await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(join(state, 'workspace-settings.json'), '{"retained":"original absolute paths"}', { mode: 0o600 });
  return state;
}

test('fresh Home plan is read-only and initialization creates one canonical central selection', async t => {
  const home = await fixture(t), before = await readdir(home);
  const plan = await inspectWorkerHome(home, app);
  assert.deepEqual(await readdir(home), before); assert.equal(plan.stateDirectory, join(home, 'state/worker'));
  assert.equal(plan.migrationRequired, false); assert.equal(plan.projectsDirectory, join(home, 'projects'));
  const initialized = await selectWorkerHome(home, app, { initialize: true });
  assert.equal(initialized.adopted, true); assert.equal(initialized.layout, 'central');
  assert.deepEqual(JSON.parse(await readFile(join(home, 'state/home.json'), 'utf8')), { schemaVersion: 1, homeDir: home, stateDirectory: join(home, 'state/worker'), layout: 'central' });
  assert.equal((await selectWorkerHome(home, app, { initialize: true })).stateDirectory, initialized.stateDirectory);
});

test('old standalone state is discovered and explicitly selected without moving checkout paths or rewriting data', async t => {
  const home = await fixture(t), original = await legacy(home, 'werk-0.16.0/.werk/worker');
  const bytes = await readFile(join(original, 'workspace-settings.json'));
  const plan = await inspectWorkerHome(home, app); assert.equal(plan.migrationRequired, true);
  assert.equal(plan.legacyCandidates[0].compatible, true);
  await assert.rejects(selectWorkerHome(home, app, { initialize: true }), /migration plan/);
  await assert.rejects(readFile(join(home, 'state/home.json')), { code: 'ENOENT' });
  const adopted = await selectWorkerHome(home, app, { adoptState: original });
  assert.equal(adopted.layout, 'legacy'); assert.equal(adopted.stateDirectory, original);
  assert.deepEqual(await readFile(join(original, 'workspace-settings.json')), bytes);
  await assert.rejects(readFile(join(home, 'state/worker/workspace-settings.json')), { code: 'ENOENT' });
  assert.equal((await selectWorkerHome(home, app, { initialize: true })).stateDirectory, original);
  await rm(original, { recursive: true });
  await assert.rejects(selectWorkerHome(home, app, { initialize: true }), /absent or empty/);
});

test('adoption preserves ambiguous, unverified, and project-installed worker state for explicit recovery', async t => {
  const home = await fixture(t), state = await legacy(home);
  await writeFile(join(state, 'worker.lock'), '{}', { mode: 0o600 });
  await assert.rejects(selectWorkerHome(home, app, { adoptState: state }), /locks are preserved/);
  await rm(join(state, 'worker.lock'));
  await writeFile(join(home, '.werk/worker-project.json'), '{"schemaVersion":1,"port":4100}', { mode: 0o600 });
  const installed = await inspectWorkerHome(home, app); assert.equal(installed.legacyCandidates[0].compatible, false);
  await assert.rejects(selectWorkerHome(home, app, { adoptState: state }), /Project-installed/);
  await rm(join(home, '.werk/worker-project.json'));
  const other = await legacy(home, 'werk-0.15.0/.werk/worker');
  await assert.rejects(selectWorkerHome(home, app, { adoptState: state }), /Multiple populated/);
  await rm(other, { recursive: true });
  await mkdir(join(home, 'state/worker'), { recursive: true, mode: 0o700 });
  await writeFile(join(home, 'state/worker', 'identity.json'), '{}', { mode: 0o600 });
  await assert.rejects(selectWorkerHome(home, app, { adoptState: state }), /Multiple populated/);
  await assert.rejects(readFile(join(home, 'state/home.json')), { code: 'ENOENT' });
});

test('Home cannot silently change state selection or follow linked state', async t => {
  const home = await fixture(t), state = await legacy(home);
  await selectWorkerHome(home, app, { adoptState: state });
  const other = await fixture(t); await legacy(other);
  await writeFile(join(home, 'state/home.json'), JSON.stringify({ schemaVersion: 1, homeDir: other, stateDirectory: state, layout: 'legacy' }), { mode: 0o600 });
  await assert.rejects(selectWorkerHome(home, app), /Invalid Home selection/);
  if (process.platform !== 'win32') {
    await rm(join(home, 'state'), { recursive: true }); await symlink(other, join(home, 'state'), 'dir');
    await assert.rejects(selectWorkerHome(home, app, { initialize: true }), /real private directory/);
  }
});

test('invalid placement is rejected before creating selection files in a copied app', async t => {
  const application = await fixture(t), before = await readdir(application);
  await assert.rejects(selectWorkerHome(application, application, { initialize: true }), /outside the copied app/);
  assert.deepEqual(await readdir(application), before);
});

test('migration never adopts state inside the replaceable runtime payload', async t => {
  const home = await fixture(t), state = await legacy(home, 'runtime/old-worker-state');
  await assert.rejects(selectWorkerHome(home, app, { adoptState: state }), /replaceable Home\/runtime/);
  await assert.rejects(readFile(join(home, 'state/home.json')), { code: 'ENOENT' });
});

test('Home launcher serializes legacy state adoption with startup and payload updates', async t => {
  const home = await fixture(t), state = await legacy(home);
  const module = new URL('../../scripts/runtime/portable/home.mjs', import.meta.url).href;
  const code = 'const { workerHome } = await import(process.argv[1]); await workerHome(process.argv.slice(3), { homeRoot: process.argv[2] });';
  const launch = () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, module, home, 'migration', 'adopt', '--state-dir', state], { timeout: 20000, windowsHide: true });
  await withHomeRuntimeLock(home, async () => {
    await assert.rejects(launch(), /Another Home startup or update/);
    await assert.rejects(readFile(join(home, 'state/home.json')), { code: 'ENOENT' });
  });
  const result = await launch();
  assert.equal(JSON.parse(result.stdout).stateDirectory, state);
});

test('bounded legacy discovery refuses an oversized Home instead of missing an old worker', async t => {
  const home = await fixture(t);
  for (let index = 0; index < 257; index++) await writeFile(join(home, 'item-' + index), '');
  await assert.rejects(inspectWorkerHome(home, app), /exceeds 256/);
  await assert.rejects(readFile(join(home, 'state/home.json')), { code: 'ENOENT' });
});
