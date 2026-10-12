import { join } from 'node:path';
import { writeFile, rename, lstat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { loadDefinition, planDefinition } from '../system/definition.mjs';
import { setupSystem, loadSystem, factoryCredentials, tokenEnv } from '../system/state.mjs';
import { bootstrapSystem, factoryRequest } from '../system/bootstrap.mjs';
import { loadSetup, privateDirectory, createPrivate, readPrivate } from '../runtime/config.mjs';
import { composeSystem, systemProject } from './system-compose.mjs';
const stateDir = process.env.WERK_CONTAINER_STATE_DIR ?? '/state';
const [command, ...args] = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--file','--environment','--host-state','--image','--uid','--gid','--volume'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw Error('Unknown or duplicate Docker system option');
  options[args[i]] = args[i + 1];
}
async function definition() {
  const value = options['--file'] ? await loadDefinition(options['--file'], options['--environment'] ? { environment: options['--environment'] } : {}) : await loadSystem(stateDir);
  if (options['--file'] && !['plan','id','setup'].includes(command) && JSON.stringify(value) !== JSON.stringify(await loadSystem(stateDir))) throw Error('Definition differs from installed system');
  if (value.environment !== 'docker') throw Error('Docker launcher requires environment docker; pass --environment docker explicitly');
  return value;
}
async function ensurePrivate(path, value) {
  try { await createPrivate(path, value); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (JSON.stringify(await readPrivate(path)) !== JSON.stringify(value)) throw Error('Private Docker system configuration differs from saved state');
}
async function replacePrivate(path, value) {
  const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (info && (!info.isFile() || info.isSymbolicLink())) throw Error('Docker metadata must be a regular file');
  const temp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  await writeFile(temp, value, { flag: 'wx', mode: 0o600 }); await rename(temp, path);
}
async function probe(url, token) {
  try { const parsed = new URL(url); const result = await factoryRequest(parsed.origin, token ?? '', parsed.pathname); return result.status === 200 ? result.value : null; } catch { return null; }
}
async function status(value, captureIdentity = false) {
  const credentials = await factoryCredentials(stateDir, value);
  const factory = await probe('http://factory:3100/v1/overview', credentials.adminToken);
  const registeredFactories = [{ id: value.factory.id, name: value.factory.name, parentId: null }, ...value.factory.subFactories];
  const registryReady = registeredFactories.every(expected => factory?.factories?.some(actual => Object.entries(expected).every(([key, item]) => actual[key] === item)))
    && value.productionLines.every((line, index) => factory?.lines?.some(actual => actual.status === 'available' && actual.line.id === line.id && actual.line.name === line.name && actual.line.factoryId === line.factoryId && actual.line.orchestratorUrl === `http://line-${index + 1}:3000` && actual.line.tokenEnv === tokenEnv(index)));
  const lines = await Promise.all(value.productionLines.map(async (line, i) => {
    const overview = await probe(`http://line-${i + 1}:3000/v1/overview`, credentials.credentials[tokenEnv(i)]);
    const workers = await Promise.all(Array.from({ length: line.workers.count }, async (_, n) => {
      const worker = await probe(`http://line-${i + 1}-worker-${n + 1}:4100/status`);
      const registered = typeof worker?.workerId === 'string' ? await probe(`http://line-${i + 1}:3000/v1/workers/${encodeURIComponent(worker.workerId)}`, credentials.credentials[tokenEnv(i)]) : null;
      return { id: `worker-${n + 1}`, workerId: worker?.workerId ?? null, ready: worker?.mode === 'mock' && worker.project === line.project && registered?.id === worker.workerId && registered?.project === line.project && ['idle','executing'].includes(worker.state), state: worker?.state ?? 'unavailable' };
    }));
    return { id: line.id, project: line.project, ready: overview?.mode === 'mock' && overview.project === line.project && workers.every(worker => worker.ready), workers };
  }));
  const identities = lines.map(line => ({ lineId: line.id, workers: line.workers.map(worker => ({ id: worker.id, workerId: worker.workerId })) }));
  const identityFile = join(stateDir, 'factory', 'docker-worker-identities.json');
  if (captureIdentity && lines.every(line => line.ready)) await ensurePrivate(identityFile, identities);
  const savedIdentities = await readPrivate(identityFile).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  const identitiesMatch = JSON.stringify(savedIdentities) === JSON.stringify(identities);
  return { schemaVersion: 1, environment: 'docker', execution: 'mock', id: value.id, ready: !!factory && registryReady && identitiesMatch && lines.every(line => line.ready), workerIdentities: identitiesMatch ? 'verified' : 'unverified', url: `http://127.0.0.1:${value.factory.port}/`, factory: factory ? (registryReady ? 'healthy' : 'registry-mismatch') : 'unavailable', productionLines: lines };
}
try {
  const value = await definition();
  if (command === 'plan') console.log(JSON.stringify(planDefinition(value)));
  else if (command === 'id') console.log(value.id);
  else if (command === 'setup') {
    if (!options['--host-state']) throw Error('Docker setup requires host identity');
    await setupSystem(value, { stateDir });
    const factoryInput = join(stateDir, 'factory-input');
    await privateDirectory(factoryInput); await privateDirectory(join(factoryInput, 'factory')); await privateDirectory(join(factoryInput, 'lines'));
    await ensurePrivate(join(factoryInput, 'system.json'), { schemaVersion: 1, definition: value });
    for (const [i, line] of value.productionLines.entries()) {
      const lineRoot = join(stateDir, 'lines', line.id), { config, credentials } = await loadSetup(lineRoot);
      const inputLine = join(factoryInput, 'lines', line.id); await privateDirectory(inputLine);
      await ensurePrivate(join(inputLine, 'credentials.json'), credentials);
      await ensurePrivate(join(inputLine, 'config.json'), config);
      if (JSON.stringify(await readPrivate(join(inputLine, 'credentials.json'))) !== JSON.stringify(credentials)) throw Error('Factory credentials differ from immutable system configuration');
      await privateDirectory(join(lineRoot, 'workers'));
      for (let n = 1; n <= line.workers.count; n++) {
        const worker = join(lineRoot, 'workers', `worker-${n}`); await privateDirectory(worker);
        const enrollment = { schemaVersion: 1, runtime: 'docker', url: `http://line-${i + 1}:3000`, enrollmentToken: credentials.WERK_ENROLLMENT_TOKEN };
        const file = join(worker, 'enrollment.json'); await ensurePrivate(file, enrollment);
        if (JSON.stringify(await readPrivate(file)) !== JSON.stringify(enrollment)) throw Error('Worker enrollment differs from immutable system configuration');
      }
    }
    const project = systemProject(value, options['--host-state']);
    const image = options['--image'] ?? `werk-release:${project}`;
    const compose = composeSystem(value, { hostState: options['--host-state'], image, uid: options['--uid'], gid: options['--gid'], volume: options['--volume'] });
    await replacePrivate(join(stateDir, 'docker-compose.json'), JSON.stringify(compose, null, 2) + '\n');
    await replacePrivate(join(stateDir, 'docker-project'), project + '\n');
    await replacePrivate(join(stateDir, 'docker-image'), image + '\n');
    console.log(JSON.stringify({ configured: true, id: value.id, environment: 'docker', execution: 'mock', project, url: `http://127.0.0.1:${value.factory.port}/`, credentialsPrinted: false }));
  } else if (command === 'bootstrap') {
    const credentials = await factoryCredentials(stateDir, value);
    await bootstrapSystem(value, credentials, { factoryUrl: 'http://factory:3100', internalUrls: value.productionLines.map((_, i) => `http://line-${i + 1}:3000`) });
    const result = await status(value, true); console.log(JSON.stringify(result)); if (!result.ready) process.exitCode = 1;
  } else if (command === 'status' || command === 'doctor') {
    const result = await status(value); console.log(JSON.stringify(result)); if (!result.ready) process.exitCode = 1;
  } else if (command === 'verify') console.log(JSON.stringify({ verified: true }));
  else if (command === 'credentials') console.log(JSON.stringify({ credentialsDirectory: options['--host-state'], credentialsPrinted: false }));
  else if (command === 'credential-paths') console.log(['factory/credentials.json', ...value.productionLines.map(line => `lines/${line.id}/credentials.json`)].join('\n'));
  else if (command === 'url') console.log(`http://127.0.0.1:${value.factory.port}/`);
  else if (command === 'services') console.log(value.productionLines.flatMap((line, i) => Array.from({length:line.workers.count},(_,n)=>`line-${i+1}-worker-${n+1}`)).concat(value.productionLines.map((_,i)=>`line-${i+1}`),'factory').join('\n'));
  else throw Error('Unknown Docker system command');
} catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
