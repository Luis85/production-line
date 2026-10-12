import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { releaseRoot, readPrivate } from './config.mjs';

export async function checkArtifacts(root = releaseRoot) {
  const required = ['src/orchestrator/dist/orchestrator/server.js', 'src/orchestrator/dist/orchestrator/public/index.html', 'src/orchestrator/dist/node_modules/yaml/package.json',
    'src/worker/dist/worker/runner.js', 'src/worker/dist/worker/config.js'];
  for (const path of required) await access(join(root, path)).catch(() => { throw Error(`Prebuilt release file missing: ${path}. Extract a complete Werk release; do not run npm install to repair it.`); });
}
export async function freePort(port) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', () => reject(Error(`Port ${port} is unavailable. Stop its owner or choose other ports in config.json.`))); server.listen(port, '127.0.0.1', () => server.close(resolve)); });
}
async function json(url, token) {
  const response = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {}, redirect: 'error', signal: AbortSignal.timeout(800) });
  if (!response.ok) throw Error('Service is not ready');
  const reader = response.body?.getReader(); let size = 0; const chunks = [];
  try { if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 1048576) { await reader.cancel(); throw Error('Unexpected health response'); } chunks.push(value); } }
  finally { reader?.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function orchestratorReady(config, credentials) {
  const value = await json(`http://127.0.0.1:${config.orchestratorPort}/v1/overview`, credentials.WERK_ADMIN_TOKEN);
  return value.project === config.project && ['mock', 'cli', 'mixed'].includes(value.mode) && value.schemaVersion === 1;
}
export async function workerReady(config, credentials, stateDir, index) {
  const identity = await readPrivate(join(stateDir, 'workers', `worker-${index}`, 'identity.json'));
  const status = await json(`http://127.0.0.1:${config.workerPort + index - 1}/status`);
  if (status.workerId !== identity.id || status.project !== config.project || !['idle', 'executing'].includes(status.state) || status.mode !== config.mode) return false;
  const page = await json(`http://127.0.0.1:${config.orchestratorPort}/v1/workers?limit=1000`, credentials.WERK_ADMIN_TOKEN);
  return Array.isArray(page.workers) && page.workers.some(worker => worker.id === identity.id && worker.project === config.project);
}
export async function waitFor(check, alive, signal, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted(); if (!alive()) throw Error(`${label} exited during startup. Check setup, selected ports and private runtime logs.`);
    try { if (await check()) return; } catch { /* Health becomes ready after listeners, enrollment and identity persistence. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(`${label} did not become healthy within ${timeoutMs} ms. Check configuration, credentials and selected ports.`);
}
