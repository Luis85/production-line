import { withOwnedResponse } from './shared-http.mjs';
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readPrivate, inputError } from './config.mjs';
import { join } from 'node:path';

const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function validMetadata(value) {
  if (!value || value.schemaVersion !== 1 || !hex(value.runId) || !hex(value.controlToken) || !Number.isInteger(value.pid) || value.pid < 1 ||
      !Number.isInteger(value.controlPort) || value.controlPort < 1 || value.controlPort > 65535 || !Array.isArray(value.children) ||
      value.children.some(child => !Number.isInteger(child.pid) || child.pid < 1 || !['orchestrator', 'worker', 'line', 'factory'].includes(child.role))) throw inputError('Invalid supervisor metadata. Do not signal stored PIDs; inspect private state before recovery.');
  return value;
}
async function metadata(stateDir) { return validMetadata(await readPrivate(join(stateDir, 'supervisor.json'))); }
export async function controlRequest(record, action = 'status') {
  validMetadata(record);
  return withOwnedResponse(`http://127.0.0.1:${record.controlPort}/${action}`, { method: action === 'stop' ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + record.controlToken, 'X-Werk-Run': record.runId }, redirect: 'error' }, 1200, async response => {
    const reader = response.body?.getReader(); let bytes = 0, body = '';
    try {
      if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 16384) { await reader.cancel(); throw Error('Invalid supervisor response.'); } body += Buffer.from(value).toString('utf8'); }
    } finally { reader?.releaseLock(); }
    const result = JSON.parse(body);
    if (!response.ok || result.runId !== record.runId || !['starting', 'running', 'stopping'].includes(result.state)) throw Error('Supervisor identity could not be verified.');
    if (!['mock', 'cli', 'mixed'].includes(result.mode)) throw Error('Invalid supervisor execution mode.');
    // Only explicitly supported public fields leave this trust boundary.
    return { state: result.state, runId: result.runId, project: result.project, mode: result.mode, url: result.url, workers: result.workers };
  }, false);
}
export async function createControl({ runId, controlToken, snapshot, stop }) {
  const server = createServer((request, response) => {
    const answer = (code, value) => { response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close' }); response.end(JSON.stringify(value)); };
    const authorization = Buffer.from(request.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + controlToken);
    if ((request.headersDistinct.authorization?.length ?? 0) !== 1 || authorization.length !== expected.length ||
        !timingSafeEqual(authorization, expected) || (request.headersDistinct['x-werk-run']?.length ?? 0) !== 1 || request.headers['x-werk-run'] !== runId) { request.resume(); return answer(401, { error: 'Supervisor authentication required' }); }
    if (request.headers['transfer-encoding'] || (request.headers['content-length'] && request.headers['content-length'] !== '0')) { request.resume(); return answer(400, { error: 'Control commands have no request body' }); }
    if (request.method === 'GET' && request.url === '/status') return answer(200, snapshot());
    if (request.method === 'POST' && request.url === '/stop') { answer(202, { ...snapshot(), state: 'stopping' }); void stop(); return; }
    answer(404, { error: 'Unknown supervisor endpoint' });
  });
  server.requestTimeout = 3000; server.headersTimeout = 2000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server;
}
export async function runtimeStatus(stateDir) {
  let record;
  try { record = await metadata(stateDir); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { await readPrivate(join(stateDir, 'runtime.lock')); return { state: 'unreachable', action: 'A runtime lock exists without supervisor metadata. Startup may be in progress; retry shortly. If it crashed, verify all owned processes exited before removing stale metadata.' }; }
    catch (lockError) { if (lockError.code === 'ENOENT') return { state: 'stopped' }; throw lockError; }
  }
  try { return await controlRequest(record); }
  catch { return { state: 'unreachable', action: 'Supervisor identity is unreachable. No stored PID was signalled. Retry shortly; after a crash, verify all owned processes exited before removing runtime.lock and supervisor.json.' }; }
}
export async function stopRuntime(stateDir, timeoutMs = 25000) {
  const status = await runtimeStatus(stateDir);
  if (status.state === 'stopped') return status;
  if (status.state === 'unreachable') throw inputError(status.action);
  const record = await metadata(stateDir); await controlRequest(record, 'stop');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await runtimeStatus(stateDir);
    if (current.state === 'stopped') return current;
    if (current.runId && current.runId !== record.runId) throw Error('A different runtime started while stopping. It was not stopped.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Runtime did not finish stopping in time. Inspect status; no unrelated PID was signalled.');
}
