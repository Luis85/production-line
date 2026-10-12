import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile, lstat, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, loadSetup, privateDirectory, createPrivate, readPrivate } from '../runtime/config.mjs';

const stateDir = process.env.WERK_CONTAINER_STATE_DIR ?? '/state';
const [command = 'help', ...args] = process.argv.slice(2);
function options(values, allowed) {
  const result = {};
  for (let i = 0; i < values.length; i++) {
    const key = values[i].replace(/^--/, '');
    if (values[i] === '--json') continue;
    if (!values[i].startsWith('--') || !allowed.includes(key) || result[key] !== undefined || !values[i + 1] || values[i + 1].startsWith('--')) throw Error('Invalid Docker command options');
    result[key] = values[++i];
  }
  return result;
}
function singleWorker(config) {
  if (config.runtime !== 'docker') throw Error('This state directory belongs to native mode. Use node werk.mjs or a separate Docker state directory.');
  if (config.workers !== 1) throw Error('Docker release supports one worker. Use a separate state directory with setup --workers 1, or use native mode for multiple workers.');
}
async function read() { const value = await loadSetup(stateDir); singleWorker(value.config); return value; }
async function endpoint(path, token) {
  const response = await fetch('http://orchestrator:3000' + path, { headers: token ? { Authorization: 'Bearer ' + token } : {}, signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw Error('Orchestrator is not ready');
  return response.json();
}
try {
  if (command === 'setup') {
    const values = options(args, ['project', 'port', 'worker-port', 'workers', 'host-state']);
    if (!values['host-state'] || /[\r\n]/.test(values['host-state'])) throw Error('Docker setup needs a host state directory');
    if (values.workers !== undefined && values.workers !== '1') throw Error('Docker release supports --workers 1');
    const requested = { stateDir, runtime: 'docker' };
    for (const [flag, key] of [['project','project'],['port','port'],['worker-port','workerPort'],['workers','workers']]) if (values[flag] !== undefined) requested[key] = flag === 'project' ? values[flag] : Number(values[flag]);
    await setup(requested);
    const { config, credentials } = await read();
    await privateDirectory(join(stateDir, 'workers'));
    const workerState = join(stateDir, 'workers', 'worker-1'); await privateDirectory(workerState);
    const enrollmentFile = join(workerState, 'enrollment.json');
    const enrollment = { schemaVersion: 1, runtime: 'docker', enrollmentToken: credentials.WERK_ENROLLMENT_TOKEN };
    try {
      const existing = await readPrivate(enrollmentFile);
      if (JSON.stringify(existing) !== JSON.stringify(enrollment)) throw Error('Worker enrollment configuration differs; restore its original setup');
    } catch (error) { if (error.code !== 'ENOENT') throw error; await createPrivate(enrollmentFile, enrollment); }
    const project = 'werk-' + createHash('sha256').update(values['host-state']).digest('hex').slice(0, 12);
    const metadata = join(stateDir, 'docker.env');
    try { const info = await lstat(metadata); if (!info.isFile() || info.isSymbolicLink()) throw Error('Docker metadata must be a regular file'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = metadata + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, `WERK_DOCKER_PROJECT=${project}\nWERK_ORCHESTRATOR_PORT=${config.orchestratorPort}\nWERK_WORKER_PORT=${config.workerPort}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, metadata);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    console.log(JSON.stringify({ configured: true, mode: 'docker', execution: 'mock', url: `http://127.0.0.1:${config.orchestratorPort}`, credentialsFile: 'credentials.json', credentialsPrinted: false }));
  } else if (command === 'status') {
    options(args, []);
    const { config, credentials } = await read();
    let health = null, worker = null;
    try { health = await endpoint('/v1/overview', credentials.WERK_ADMIN_TOKEN); } catch {}
    try { const response = await fetch('http://worker:4100/status', { signal: AbortSignal.timeout(3000) }); if (response.ok) worker = await response.json(); } catch {}
    const ready = health !== null && worker !== null && ['idle', 'executing'].includes(worker.state);
    console.log(JSON.stringify({ mode: 'docker', execution: 'mock', ready, url: `http://127.0.0.1:${config.orchestratorPort}`, orchestrator: health === null ? 'unavailable' : 'healthy', worker: worker?.state ?? 'unavailable' }));
    if (!ready) process.exitCode = 1;
  } else if (command === 'url') {
    options(args, []); const { config } = await read(); console.log(`http://127.0.0.1:${config.orchestratorPort}`);
  } else if (command === 'cli') {
    const { credentials } = await read();
    const child = spawn(process.execPath, ['/app/src/orchestrator/dist/orchestrator/cli.js', ...args], { stdio: 'inherit', env: { ...process.env, WERK_URL: 'http://orchestrator:3000', WERK_ADMIN_TOKEN: credentials.WERK_ADMIN_TOKEN } });
    child.on('error', () => { console.error('Unable to launch packaged orchestrator CLI'); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  } else if (command === 'logs-json') {
    options(args, []); let body = '';
    for await (const chunk of process.stdin) { body += chunk; if (Buffer.byteLength(body) > 1024 * 1024) throw Error('Log response exceeds 1 MiB; reduce the Docker log tail'); }
    console.log(JSON.stringify({ lines: body.split(/\r?\n/).filter(Boolean) }));
  } else if (command === 'help') {
    console.log('Docker release: setup, start, status, logs, stop, cli. Use the host werk-docker wrapper. Execution is mock.');
  } else throw Error('Unknown Docker operator command');
} catch (error) { console.error(error instanceof Error ? error.message : 'Docker operation failed'); process.exitCode = 1; }
