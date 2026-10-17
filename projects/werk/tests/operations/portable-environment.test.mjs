import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, chmod, stat, access, realpath, symlink } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ownWorkspace } from '../helpers/workspace-processes.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url)), exec = promisify(execFile);
const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('WERK_')));
async function invoke(entry, cwd, args, environment = {}) {
  try { return { code: 0, ...await exec(process.execPath, [entry, ...args], { cwd, env: { ...cleanEnvironment, ...environment }, timeout: 45000, maxBuffer: 1048576 }) }; }
  catch (error) { if (!Number.isInteger(error.code)) throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}
async function ok(...args) { const result = await invoke(...args); assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout); }
for (const kind of ['worker', 'factory', 'orchestrator']) test(`${kind} portable environment controls actual credentials and root-relative state across restart`, { timeout: 120000 }, async t => {
  const outer = await realpath(await mkdtemp(join(tmpdir(), 'werk environment '))), project = join(outer, 'project'), elsewhere = join(outer, 'caller');
  await mkdir(project); await mkdir(elsewhere);
  const app = join(project, 'bin/apps', kind), entry = join(app, 'cli.mjs'), state = join(project, 'private-state', kind), path = join(project, '.env');
  await cp(join(root, 'bin/apps', kind), app, { recursive: true });
  if (kind === 'worker') await exec('git', ['init', '--quiet'], { cwd: project });
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(join(state, kind === 'worker' ? 'webview-token' : 'component.json'), kind === 'worker' ? 'a'.repeat(64) + '\n' : JSON.stringify({ schemaVersion: 1, kind, project: 'demo', adminToken: 'a'.repeat(64), enrollmentToken: 'd'.repeat(64) }), { mode: 0o600 });
  await ownWorkspace(t, outer, async () => { await invoke(entry, elsewhere, ['stop', '--state-dir', state]); });
  const prefix = `WERK_${kind.toUpperCase()}`, key = kind === 'worker' ? 'WERK_WORKER_TOKEN' : kind === 'factory' ? 'WERK_FACTORY_ADMIN_TOKEN' : 'WERK_ADMIN_TOKEN';
  const initial = `# Operator settings stay byte-for-byte intact\nCUSTOM_VALUE='literal $HOME'\n${prefix}_STATE_DIR='private-state/${kind}'\n${prefix}_PORT=45991\n`;
  await writeFile(path, initial, { mode: 0o644 });
  const setup = await ok(entry, elsewhere, ['env', 'init', '--project-dir', project]);
  assert.equal(setup.path, path); assert.ok(setup.added.includes(key));
  const contents = await readFile(path, 'utf8'), values = parseEnv(contents), token = values[key];
  assert.ok(contents.startsWith(initial)); assert.equal(token, 'a'.repeat(64), 'environment init adopts the effective existing state identity'); assert.ok(!JSON.stringify(setup).includes(token));
  assert.match(await readFile(join(project, '.gitignore'), 'utf8'), /^\.env$/m);
  assert.ok(!(await readFile(join(project, '.env.example'), 'utf8')).includes(token));
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o077, 0);
  await ok(entry, elsewhere, ['env', 'init', '--project-dir', project]); assert.equal(await readFile(path, 'utf8'), contents);
  let started = await ok(entry, elsewhere, ['start', '--project-dir', project, '--port', '0'], { [`${prefix}_PORT`]: '45992' });
  assert.equal(started.stateDirectory, state); assert.ok(!['45991', '45992'].includes(new URL(started.url).port));
  const route = kind === 'worker' ? '/api/settings' : '/v1/overview';
  assert.equal((await fetch(started.url + route, { headers: { authorization: 'Bearer ' + token } })).status, 200);
  assert.equal((await fetch(started.url + route, { headers: { authorization: 'Bearer ' + 'c'.repeat(64) } })).status, 401);
  const command = kind === 'worker' ? ['settings', 'get'] : ['overview'];
  await ok(entry, elsewhere, [...command, '--project-dir', project]);
  // An explicit remote URL never receives a token inferred from the local .env or private state.
  const remote = await invoke(entry, elsewhere, [...command, '--project-dir', project, '--url', started.url]);
  assert.equal(remote.code, 2); assert.match(remote.stderr, /explicit credential|Remote --url requires/);
  const rotated = 'b'.repeat(64);
  await ok(entry, elsewhere, ['stop', '--state-dir', state]);
  started = await ok(entry, elsewhere, ['start', '--project-dir', project, '--port', '0'], { [key]: rotated });
  assert.equal((await fetch(started.url + route, { headers: { authorization: 'Bearer ' + rotated } })).status, 200);
  assert.equal((await fetch(started.url + route, { headers: { authorization: 'Bearer ' + token } })).status, 401);
  assert.equal(await readFile(path, 'utf8'), contents, 'process overrides never rewrite operator dotenv values');
  const saved = kind === 'worker' ? (await readFile(started.credentialsFile, 'utf8')).trim() : JSON.parse(await readFile(started.credentialsFile, 'utf8')).adminToken;
  assert.equal(saved, rotated); assert.ok(!JSON.stringify(started).includes(rotated));
  // Recovery is independent of malformed project dotenv, and omitted overrides retain the saved identity.
  await writeFile(path, `${key}=broken\n${key}=duplicate\n`, { mode: 0o600 });
  assert.equal((await invoke(entry, elsewhere, ['status', '--project-dir', project])).code, 2);
  assert.equal((await ok(entry, elsewhere, ['status', '--state-dir', state])).state, 'running');
  await ok(entry, elsewhere, ['stop', '--state-dir', state]); await rm(path);
  started = await ok(entry, elsewhere, ['start', '--state-dir', state, '--port', '0']);
  assert.equal((await fetch(started.url + route, { headers: { authorization: 'Bearer ' + rotated } })).status, 200);
  await ok(entry, elsewhere, ['stop', '--state-dir', state]);
});

test('project init and npm use the same root environment while Docker receives explicit env-file guidance', { timeout: 120000 }, async t => {
  const outer = await realpath(await mkdtemp(join(tmpdir(), 'werk environment npm '))), project = join(outer, 'project'), elsewhere = join(outer, 'caller');
  await mkdir(project); await mkdir(elsewhere);
  const installed = await ok(join(root, 'bin/apps/worker/cli.mjs'), elsewhere, ['init', '--project-dir', project]);
  const entry = join(installed.application, 'cli.mjs'), state = join(project, '.werk/worker'), path = join(project, '.env');
  await ownWorkspace(t, outer, async () => { await invoke(entry, elsewhere, ['stop', '--state-dir', state]); });
  const contents = await readFile(path, 'utf8'), token = parseEnv(contents).WERK_WORKER_TOKEN;
  assert.equal(installed.environment.path, path); assert.ok(!JSON.stringify(installed).includes(token));
  assert.match(installed.commands.docker, /compose --env-file \.env -f/);
  assert.match(await readFile(join(project, '.werk/compose.worker.yaml'), 'utf8'), /working_dir: \/project/);
  let npm;
  for (const candidate of [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean)) { try { await access(candidate); npm = candidate; break; } catch {} }
  assert.ok(npm, 'Node installation includes npm');
  const started = await ok(npm, installed.application, ['--silent', '--prefix', installed.application, 'run', 'start', '--', '--port', '0'], { npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' });
  assert.equal(started.stateDirectory, state);
  assert.equal((await fetch(started.url + '/api/settings', { headers: { authorization: 'Bearer ' + token } })).status, 200);
  await ok(entry, elsewhere, ['stop', '--state-dir', state]);
  await ok(entry, elsewhere, ['init', '--project-dir', project]); assert.equal(await readFile(path, 'utf8'), contents);
  if (process.platform !== 'win32') {
    await chmod(path, 0o644);
    assert.equal((await invoke(entry, elsewhere, ['start', '--project-dir', project, '--port', '0'])).code, 2);
    assert.equal((await ok(entry, elsewhere, ['status', '--state-dir', state])).state, 'stopped');
  }
});

test('project init adopts custom state selected by dotenv or process and never copies installer credentials', { timeout: 60000 }, async t => {
  const outer = await realpath(await mkdtemp(join(tmpdir(), 'werk environment setup ')));
  t.after(() => rm(outer, { recursive: true, force: true }));
  const source = join(outer, 'installer'); await cp(join(root, 'bin/apps/worker'), source, { recursive: true });
  await writeFile(join(source, '.env'), 'WERK_WORKER_TOKEN=' + 'f'.repeat(64) + '\n', { mode: 0o600 });
  await mkdir(join(source, '.werk')); await writeFile(join(source, '.werk/private-state'), 'installer-only');
  for (const selector of ['dotenv', 'process']) {
    const project = join(outer, selector), state = join(project, 'existing-state'); await mkdir(state, { recursive: true, mode: 0o700 });
    await writeFile(join(state, 'webview-token'), 'e'.repeat(64) + '\n', { mode: 0o600 });
    if (selector === 'dotenv') await writeFile(join(project, '.env'), 'WERK_WORKER_STATE_DIR=existing-state\n', { mode: 0o600 });
    const environment = selector === 'process' ? { WERK_WORKER_STATE_DIR: 'existing-state', WERK_WORKER_PORT: '4209' } : {};
    const installed = await ok(join(source, 'cli.mjs'), outer, ['init', '--project-dir', project], environment);
    assert.equal(installed.stateDirectory, state);
    const values = parseEnv(await readFile(join(project, '.env'), 'utf8'));
    assert.equal(values.WERK_WORKER_TOKEN, 'e'.repeat(64)); assert.equal(values.WERK_WORKER_STATE_DIR, 'existing-state');
    if (selector === 'process') assert.equal(values.WERK_WORKER_PORT, '4209');
    await assert.rejects(access(join(installed.application, '.env')), { code: 'ENOENT' });
    await assert.rejects(access(join(installed.application, '.werk')), { code: 'ENOENT' });
    await access(join(installed.application, '.env.example'));
  }
});

test('project init rejects invalid installer entries before creating environment secrets', { timeout: 60000 }, async t => {
  const outer = await realpath(await mkdtemp(join(tmpdir(), 'werk environment preflight ')));
  t.after(() => rm(outer, { recursive: true, force: true }));
  const source = join(outer, 'installer'), project = join(outer, 'project'), target = join(outer, 'target');
  await mkdir(project); await mkdir(target); await cp(join(root, 'bin/apps/worker'), source, { recursive: true });
  try { await symlink(target, join(source, 'invalid-entry'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Junction creation unavailable'); throw error; }
  const result = await invoke(join(source, 'cli.mjs'), outer, ['init', '--project-dir', project]);
  assert.equal(result.code, 2); assert.match(result.stderr, /symbolic links/);
  await assert.rejects(access(join(project, '.env')), { code: 'ENOENT' });
});
