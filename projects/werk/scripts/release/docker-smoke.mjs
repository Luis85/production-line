/** Real release lifecycle gate. Docker wrappers run without host Node in PATH. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, symlink, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const root = resolve(process.env.WERK_DOCKER_RELEASE_ROOT ?? '.');
const scratch = await mkdtemp(join(tmpdir(), 'werk-docker-release-'));
const state = join(scratch, 'private state with spaces');
const image = 'werk-release:smoke-' + process.pid;
const env = { ...process.env, WERK_DOCKER_IMAGE: image };
const freePort = async () => { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; };
let project;
try {
  const path = join(scratch, 'host-tools'); await mkdir(path);
  for (const name of ['bash', 'docker', 'id', 'mkdir', 'dirname']) {
    const binary = (await exec('/bin/sh', ['-c', 'command -v ' + name])).stdout.trim();
    if (!binary) throw Error('Docker smoke requires ' + name);
    await symlink(binary, join(path, name));
  }
  env.PATH = path;
  const logs = [];
  // Image preparation and container creation precede the unchanged Compose health deadline.
  const run = async (...args) => {
    const result = await exec(join(path, 'bash'), [join(root, 'werk-docker.sh'), ...args, '--state-dir', state], { cwd: root, env, timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
    logs.push(result.stdout, result.stderr);
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  };
  const port = await freePort(); let workerPort = await freePort(); while (workerPort === port) workerPort = await freePort();
  const configured = await run('setup', '--port', String(port), '--worker-port', String(workerPort), '--json');
  assert.equal(configured.configured, true);
  const credentials = await readFile(join(state, 'credentials.json'), 'utf8');
  const metadata = await readFile(join(state, 'docker.env'), 'utf8');
  project = /^WERK_DOCKER_PROJECT=(werk-[a-f0-9]{12})$/m.exec(metadata)?.[1]; assert.ok(project);
  await run('setup', '--json'); assert.equal(await readFile(join(state, 'credentials.json'), 'utf8'), credentials);
  const started = await run('start', '--no-open', '--json'); assert.equal(started.ready, true);
  const page = await fetch(started.url); assert.equal(page.status, 200); assert.match(await page.text(), /<html/i);
  const health = await run('status', '--json'); assert.equal(health.ready, true);
  const taskBody = JSON.stringify({ project: 'demo', title: 'Release journey smoke', criteria: ['Mock run completes with persisted evidence'] });
  const taskResult = await new Promise((resolve, reject) => {
    const child = execFile(join(path,'bash'), [join(root,'werk-docker.sh'),'cli','task','create','--file','-','--key','release-smoke','--state-dir',state], { cwd:root, env, timeout:300000, maxBuffer:1024*1024 }, (error,stdout,stderr) => error ? reject(error) : resolve({stdout,stderr}));
    child.stdin.end(taskBody);
  });
  logs.push(taskResult.stdout,taskResult.stderr);
  const task = JSON.parse(taskResult.stdout);
  let observed;
  for (let attempt = 0; attempt < 45; attempt++) {
    observed = await run('cli', 'task', 'get', '--id', task.id);
    if (observed.status === 'simulated') break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(observed.status, 'simulated');
  const firstWorker = (await run('cli','workers','list','--limit','100')).workers[0].id;
  const beforeLogs = await run('logs','--json'); assert.ok(Array.isArray(beforeLogs.lines));
  await run('stop','--json');
  await run('start','--no-open','--json');
  assert.equal((await run('cli','task','get','--id',task.id)).id,task.id);
  assert.equal((await run('cli','workers','list','--limit','100')).workers[0].id,firstWorker);
  assert.equal(await readFile(join(state,'credentials.json'),'utf8'),credentials);
  for (const token of Object.values(JSON.parse(credentials))) assert.ok(logs.every(log => !log.includes(token)), 'Credentials leaked to command output');
  console.log(JSON.stringify({ ok:true, journey:'docker-release', hostNodeInWrapperPath:false, setupRepeated:true, healthy:true, taskPersisted:true, workerIdentityPreserved:true, credentialOutput:false }));
} finally {
  if (project) await exec('docker',['compose','--project-directory',root,'--env-file',join(state,'docker.env'),'--file',join(root,'compose.release.yaml'),'--project-name',project,'down','--remove-orphans'],{env:{...process.env,WERK_DOCKER_IMAGE:image,WERK_DOCKER_STATE_DIR:state,WERK_DOCKER_UID:String(process.getuid?.()??1000),WERK_DOCKER_GID:String(process.getgid?.()??1000)},timeout:60000}).catch(()=>{});
  await exec('docker',['image','rm',image],{timeout:30000}).catch(()=>{});
  await rm(scratch,{recursive:true,force:true});
}
