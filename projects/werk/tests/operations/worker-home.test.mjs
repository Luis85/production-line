import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { packageRelease } from '../../scripts/release/package.mjs';
import { extractRelease } from '../../scripts/release/extract.mjs';
import { ownWorkspace } from '../helpers/workspace-processes.mjs';

const execute = promisify(execFile), project = fileURLToPath(new URL('../../', import.meta.url));
function isolatedEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (key.startsWith('WERK_')) delete environment[key];
  // The standalone starter must not inherit an unrelated line connection.
  return { ...environment, WERK_WORKER_ORCHESTRATOR_URL: 'http://127.0.0.1:9', WERK_URL: 'http://127.0.0.1:9', WERK_ENROLLMENT_TOKEN: 'e'.repeat(64) };
}
async function cli(entry, cwd, args = []) {
  const value = await execute(process.execPath, [entry, ...args], { cwd, env: isolatedEnvironment(), windowsHide: true, timeout: 150000, maxBuffer: 1048576 });
  return { ...value, data: JSON.parse(value.stdout) };
}
async function api(url, token, path, body) {
  const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
  const value = await response.json(); assert.equal(response.ok, true, JSON.stringify(value)); return value;
}

test('verified ZIP starts directly from an empty chosen worker home and registers Git through the authenticated webview API', { timeout: 240000 }, async t => {
  const outer = await realpath(await mkdtemp(join(tmpdir(), 'werk downloaded worker '))), artifacts = join(outer, 'artifacts'), home = join(outer, 'Chosen Worker Home');
  const packed = await packageRelease(project, artifacts), extracted = await extractRelease(artifacts, home, 'zip'), entry = join(extracted.root, 'worker.mjs');
  await ownWorkspace(t, outer, async () => { await cli(entry, home, ['stop']).catch(() => {}); });
  assert.equal(extracted.version, packed.version); assert.equal((await stat(entry)).isFile(), true);
  const readme = await readFile(join(extracted.root, 'README.md'), 'utf8'); assert.ok(readme.includes('node ./werk-' + packed.version + '/worker.mjs')); assert.equal(readme.includes('{{version}}'), false);
  const started = await cli(entry, home, ['--no-open', '--port', '0']);
  assert.equal(started.data.state, 'running'); assert.equal(started.data.kind, 'worker');
  assert.equal(started.data.stateDirectory, join(home, '.werk', 'worker'));
  assert.match(started.data.url, /^http:\/\/127\.0\.0\.1:\d+$/); assert.match(started.stderr, /Unlock the webview/);
  const token = (await readFile(started.data.credentialsFile, 'utf8')).trim(); assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal((started.stdout + started.stderr).includes(token), false);
  if (process.platform !== 'win32') assert.equal((await stat(started.data.credentialsFile)).mode & 0o077, 0);
  const page = await fetch(started.data.url, { signal: AbortSignal.timeout(10000) }); assert.equal(page.status, 200); assert.equal((await page.text()).includes(token), false);
  const denied = await fetch(started.data.url + '/api/settings', { signal: AbortSignal.timeout(10000) }); assert.equal(denied.status, 401);
  const empty = await api(started.data.url, token, '/api/managed-projects'); assert.deepEqual(empty.projects, []);
  const environment = await api(started.data.url, token, '/api/environment'); assert.ok(environment.status.machineId); assert.equal(environment.orchestratorUrl, null); assert.equal(environment.projectDirectory, null);
  const owner = JSON.parse(await readFile(join(home, '.werk/worker/portable.json'), 'utf8'));
  assert.ok(owner.launch.args.includes('--standalone')); assert.equal(owner.launch.args.includes('--url'), false);
  await assert.rejects(readFile(join(home, '.env')), { code: 'ENOENT' }); await assert.rejects(readFile(join(home, 'package.json')), { code: 'ENOENT' }); await assert.rejects(readFile(join(home, '.werk/worker-project.json')), { code: 'ENOENT' });
  const producer = join(outer, 'producer'), remote = join(outer, 'company.git'); await mkdir(producer);
  await execute('git', ['init', '--bare', '--initial-branch=main', remote]); await execute('git', ['init', '--initial-branch=main', producer]);
  await writeFile(join(producer, 'README.md'), 'A real plain Git repository for downloaded worker registration.\n');
  await execute('git', ['-C', producer, 'add', '.']); await execute('git', ['-C', producer, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Real Git fixture']);
  await execute('git', ['-C', producer, 'remote', 'add', 'origin', remote]); await execute('git', ['-C', producer, 'push', 'origin', 'main']);
  const registered = await api(started.data.url, token, '/api/managed-projects', { action: 'register', operationId: 'downloaded-register', id: 'company', repository: pathToFileURL(remote).href });
  assert.equal(registered.projects[0].status, 'ready'); assert.equal(registered.projects[0].intakeEnabled, false);
  assert.ok(registered.projects[0].path.startsWith(join(home, '.werk', 'worker', 'projects')));
  assert.equal((await readFile(join(registered.projects[0].path, 'README.md'))).length > 0, true);
  const repeated = await cli(entry, home, ['--no-open']); assert.equal(repeated.data.alreadyRunning, true); assert.equal(repeated.data.runId, started.data.runId);
  await cli(entry, home, ['stop']); assert.equal((await cli(entry, home, ['status'])).data.state, 'stopped');
  const restarted = await cli(entry, home, ['--no-open', '--port', '0']); assert.equal((await readFile(restarted.data.credentialsFile, 'utf8')).trim(), token);
  assert.equal((await api(restarted.data.url, token, '/api/environment')).status.machineId, environment.status.machineId);
  assert.equal((await api(restarted.data.url, token, '/api/managed-projects')).projects[0].id, 'company');
});

test('copied worker starter needs only Node and an explicit home outside its replaceable app folder', { timeout: 180000 }, async t => {
  const outer = await realpath(await mkdtemp(join(tmpdir(), 'werk independent starter '))), app = join(outer, 'application'), home = join(outer, 'private worker home');
  await cp(join(project, 'bin/apps/worker'), app, { recursive: true }); const entry = join(app, 'worker.mjs');
  await ownWorkspace(t, outer, async () => { await cli(entry, outer, ['stop', '--home', home]).catch(() => {}); });
  await assert.rejects(cli(entry, app, ['--no-open', '--port', '0']), error => error instanceof Error && /outside the copied app folder/.test(error.message));
  const started = await cli(entry, outer, ['--home', home, '--no-open', '--port', '0']); assert.equal(started.data.state, 'running');
  assert.equal(started.data.stateDirectory, join(home, '.werk', 'worker'));
  const token = (await readFile(started.data.credentialsFile, 'utf8')).trim(); assert.equal((await api(started.data.url, token, '/api/managed-projects')).projects.length, 0);
  if (process.platform !== 'win32') {
    const alias = join(outer, 'logical worker home'); await symlink(home, alias, 'dir');
    const replay = await cli(entry, outer, ['--home', alias, '--no-open']);
    assert.equal(replay.data.stateDirectory, join(home, '.werk', 'worker'));
    assert.equal(replay.data.runId, started.data.runId); assert.equal(replay.data.alreadyRunning, true);
  }
  const help = await cli(entry, outer, ['--help']); assert.match(help.data.home, /outside the copied app folder/);
  const manifest = JSON.parse(await readFile(join(app, 'package.json'), 'utf8')); assert.equal(manifest.dependencies, undefined);
});
