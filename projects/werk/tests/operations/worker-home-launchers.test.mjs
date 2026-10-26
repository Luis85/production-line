import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, realpath, lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { withStoppedRuntime } from '../../scripts/runtime/home-update/ownership.mjs';
import { homeWerkLauncher } from '../../scripts/release/home-launchers.mjs';
const execute = promisify(execFile);
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk-home-wrapper-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'Home'), caller = join(root, 'Caller'); await mkdir(home); await mkdir(caller);
  async function put(path, text) { await mkdir(dirname(join(home, path)), { recursive: true }); await writeFile(join(home, path), text); }
  await put('werk.mjs', homeWerkLauncher);
  await put('runtime/scripts/runtime/home-update/guard.mjs', `export { withHomeRuntimeLease } from ${JSON.stringify(new URL('../../scripts/runtime/home-update/guard.mjs', import.meta.url).href)};`);
  await put('runtime/scripts/runtime/portable/environment.mjs', `export { loadEnvironment } from ${JSON.stringify(new URL('../../scripts/runtime/portable/environment.mjs', import.meta.url).href)};`);
  // Stub only command dispatch: run the exact generated root wrapper, real private lease and environment loader.
  await put('runtime/werk.mjs', `import {readdir} from 'node:fs/promises'; import {join} from 'node:path'; const state=process.env.WERK_STATE_DIR; const leases=await readdir(${JSON.stringify(join(home, 'state/runtime-leases'))}).catch(()=>[]); console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),state,factory:process.env.WERK_FACTORY_STATE_DIR,orchestrator:process.env.WERK_ORCHESTRATOR_STATE_DIR,leases}));`);
  const environment = { ...process.env }; for (const name of Object.keys(environment)) if (name.startsWith('WERK_')) delete environment[name];
  async function run(args, extra = {}) { return JSON.parse((await execute(process.execPath, [join(home, 'werk.mjs'), ...args], { cwd: caller, env: { ...environment, ...extra }, timeout: 15000 })).stdout); }
  return { home, caller, run, environment };
}
test('Home wrapper separates line and hierarchy state without changing caller-relative options', async t => {
  const { home, caller, run } = await fixture(t);
  const line = await run(['setup', '--json']); assert.equal(line.state, join(home, 'state/line')); assert.equal(line.leases.length, 1);
  const system = await run(['system', 'plan', '--file', 'relative/system.yaml']); assert.equal(system.state, join(home, 'state/system')); assert.equal(system.cwd, caller); assert.deepEqual(system.args, ['system', 'plan', '--file', 'relative/system.yaml']); assert.deepEqual(system.leases, []);
  assert.equal((await run(['up'])).state, join(home, 'state/system'));
  const explicit = await run(['setup', '--state-dir', 'relative/state'], { WERK_STATE_DIR: 'environment-state' }); assert.equal(explicit.state, 'environment-state'); assert.deepEqual(explicit.args, ['setup', '--state-dir', 'relative/state']);
  await assert.rejects(lstat(join(home, '.werk')), { code: 'ENOENT' }); await assert.rejects(lstat(join(caller, '.werk')), { code: 'ENOENT' });
});
test('Home component defaults use visible state and preserve explicit environment, .env and flags', async t => {
  const { home, caller, run } = await fixture(t);
  assert.equal((await run(['factory', 'run'])).factory, join(home, 'state/factory'));
  assert.equal((await run(['orchestrator', 'run'])).orchestrator, join(home, 'state/orchestrator'));
  assert.equal((await run(['factory', 'run'], { WERK_FACTORY_STATE_DIR: 'explicit-environment' })).factory, 'explicit-environment');
  await writeFile(join(caller, '.env'), 'WERK_FACTORY_STATE_DIR=project-file-state\n');
  const fromFile = await run(['factory', 'run', '--state-dir', 'caller-relative']); assert.equal(fromFile.factory, 'project-file-state'); assert.deepEqual(fromFile.args, ['factory', 'run', '--state-dir', 'caller-relative']); assert.equal(fromFile.cwd, caller);

});

test('public rootwerk worker entry refuses caller project configuration and alternate worker identities', async t => {
  const { home, caller, run } = await fixture(t);
  await writeFile(join(caller, '.env'), 'INVALID_PROJECT_CONFIGURATION=must-never-load\n');
  for (const args of [['worker', 'run'], ['worker', 'run', '--state-dir', 'parallel-state'], ['worker', 'run', '--project-dir', caller]]) await assert.rejects(run(args), error => error instanceof Error && error.message.includes('Use node worker.mjs start/status/stop'));
  await assert.rejects(lstat(join(home, 'state')), { code: 'ENOENT' }); await assert.rejects(lstat(join(caller, '.werk')), { code: 'ENOENT' }); await assert.rejects(lstat(join(caller, 'parallel-state')), { code: 'ENOENT' });
});

test('foreground lease survives module readiness and excludes updates until the actual HTTP service drains', { timeout: 20000 }, async t => {
  const { home, caller, environment } = await fixture(t);
  await writeFile(join(home, 'runtime/werk.mjs'), `import { createServer } from 'node:http'; const server=createServer((req,res)=>{res.end('ok');if(req.url==='/stop')server.close();}); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port}));`);
  const child = spawn(process.execPath, [join(home, 'werk.mjs'), 'factory', 'run'], { cwd: caller, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let stderr = ''; child.stderr.on('data', value => { stderr += value; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const ready = await new Promise((resolve, reject) => { let output=''; child.once('error', reject); child.stdout.on('data', value=>{output+=value;if(output.includes('\n'))resolve(JSON.parse(output.split('\n')[0]));}); child.once('exit',()=>reject(Error('Service exited before readiness: '+stderr))); });
  // Confirm that the imported module has returned: the wrapper has no remaining initialization work, but HTTP remains live.
  assert.equal((await fetch(ready.url)).status, 200); const directory = join(home, 'state/runtime-leases'), leases = await readdir(directory); assert.equal(leases.length, 1);
  assert.equal(JSON.parse(await readFile(join(directory, leases[0]), 'utf8')).pid, child.pid);
  let mutated = false; await assert.rejects(withStoppedRuntime(home, {}, async () => { mutated = true; }), /foreground Home component/); assert.equal(mutated, false);
  await fetch(ready.url + '/stop'); const ended = await exited; assert.equal(ended.code, 0, stderr); assert.deepEqual(await readdir(directory), []);
  await withStoppedRuntime(home, {}, async () => { mutated = true; }); assert.equal(mutated, true);
});
