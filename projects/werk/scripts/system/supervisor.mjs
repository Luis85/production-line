import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { lstat, unlink, rename, access } from 'node:fs/promises';
import { releaseRoot, createPrivate, readPrivate, inputError } from '../runtime/config.mjs';
import { createControl, runtimeStatus, stopRuntime } from '../runtime/control.mjs';
import { runtimeEnvironment, logFile } from '../runtime/supervisor.mjs';
import { freePort, waitFor } from '../runtime/health.mjs';
import { captureServiceLogs, safeServiceLog, logOutputMode } from '../runtime/service-logs.mjs';
import { openBrowser } from '../runtime/browser.mjs';
import { loadSystem, factoryCredentials } from './state.mjs';
import { bootstrapSystem, factoryRequest } from './bootstrap.mjs';
import { planDefinition } from './definition.mjs';

export { runtimeStatus as systemStatus };
export const stopSystem = stateDir => stopRuntime(stateDir, 40000);
const deadline = (promise, ms) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('System shutdown deadline exceeded. Inspect private line state before recovery.')), ms); promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); }); });
export async function startSystem(stateDir, { noOpen = false, emit = () => {}, opener = openBrowser, environment = process.env, logOutput = 'file' } = {}) {
  logOutput = logOutputMode(logOutput);
  const definition = await loadSystem(stateDir);
  if (definition.environment !== 'native') throw inputError('This system belongs to Docker. Use werk-docker system with the same definition and state directory.');
  const credentials = await factoryCredentials(stateDir, definition);
  try { await access(join(releaseRoot, 'src/factory/dist/factory/server.js')); } catch { throw inputError('Factory runtime is missing. Extract a complete prebuilt release.'); }
  const plan = planDefinition(definition), runId = randomBytes(32).toString('hex'), controlToken = randomBytes(32).toString('hex');
  const recordPath = join(stateDir, 'supervisor.json'), lock = join(stateDir, 'runtime.lock');
  try { await lstat(recordPath); throw inputError('System supervisor metadata already exists. Use status/stop; never signal unverified stored PIDs.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await createPrivate(lock, { schemaVersion: 1, runId, pid: process.pid }); } catch (error) { if (error.code === 'EEXIST') throw inputError('System runtime is locked. Use status/stop; verify stale ownership before recovery.'); throw error; }
  const children = [], abort = new AbortController(); let state = 'starting', control, failure, stopping, finish, log;
  let logging = Promise.resolve();
  const ended = new Promise(resolve => { finish = resolve; });
  const snapshot = () => ({ state, runId, project: definition.id, mode: plan.mode, url: `http://127.0.0.1:${definition.factory.port}/`, workers: plan.productionLines.flatMap(line => line.workers.urls.map(url => ({ lineId: line.id, url }))) });
  const event = (event, details = {}) => {
    const value = { event, ...details }; emit(value);
    if (log) logging = logging.then(() => log.appendFile(JSON.stringify({ time: new Date().toISOString(), ...value }) + '\n')).catch(() => {});
  };
  async function persist() {
    const temporary = recordPath + '.' + randomBytes(8).toString('hex');
    await createPrivate(temporary, { schemaVersion: 1, runId, controlToken, pid: process.pid, controlPort: control.address().port,
      children: children.filter(item => item.child.pid).map(item => ({ pid: item.child.pid, role: item.role, id: item.id })) });
    try { await rename(temporary, recordPath); } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async function drain(items, grace) {
    for (const item of items) if (!item.closed && item.child.connected) item.child.send({ command: 'stop' }, () => {});
    try { await deadline(Promise.all(items.map(item => item.completion)), grace); }
    catch {
      // Kill only process handles spawned by this supervisor, never stored PID values.
      // Line IPC disconnect also initiates cooperative worker/orchestrator cleanup.
      for (const item of items) if (!item.closed) item.child.kill('SIGKILL');
      await deadline(Promise.all(items.map(item => item.completion)), 3000);
    }
  }
  function stop() {
    if (stopping) return stopping;
    state = 'stopping'; abort.abort(); event('stopping', snapshot());
    stopping = (async () => {
      try { await drain(children.filter(item => item.role === 'line'), 26000); }
      catch (error) { failure ??= error; }
      finally { await drain(children.filter(item => item.role === 'factory'), 7000); }
    })().catch(error => { failure ??= error; }).finally(finish);
    return stopping;
  }
  const signal = () => { void stop(); }; process.on('SIGINT', signal); process.on('SIGTERM', signal);
  async function launch(role, id, payload) {
    abort.signal.throwIfAborted();
    const child = spawn(process.execPath, [join(releaseRoot, 'scripts/system/child.mjs')], { cwd: releaseRoot, windowsHide: true,
      env: runtimeEnvironment(environment, { liveProvider: role === 'line' && definition.productionLines.find(line => line.id === id)?.workers.execution?.mode === 'cli' }), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const item = { child, role, id, ready: false, closed: false }; captureServiceLogs(child.stderr, entry => event('service_log', { role, id, entry }));
    child.on('message', message => {
      if (message?.event === 'ready') item.ready = true;
      // Revalidate the IPC payload; never forward arbitrary child fields or diagnostics.
      if (role === 'line' && logOutput !== 'file' && message?.event === 'service_log') {
        const entry = safeServiceLog(message.entry);
        const line = definition.productionLines.find(line => line.id === id);
        const validSource = message.role === 'orchestrator' && message.index === 0 && entry?.service === 'orchestrator'
          || message.role === 'worker' && Number.isInteger(message.index) && message.index >= 1 && message.index <= line.workers.count && entry?.service === 'worker';
        if (entry && validSource) event('service_log', { role, id, childRole: message.role, index: message.index, entry });
      }
    });
    item.completion = new Promise(resolve => {
      child.once('error', () => { failure ??= Error('A system child could not launch. Verify the complete release.'); void stop(); });
      child.once('close', code => { item.closed = true; resolve(); event('child_exited', { role, id, exitCode: code }); if (!stopping) { failure ??= Error(`System ${role} exited unexpectedly. Inspect its private state and configuration.`); void stop(); } });
    });
    children.push(item); await persist();
    if (child.connected) child.send({ command: 'start', role, logOutput, ...payload }, () => {});
    await waitFor(() => item.ready, () => !item.closed, abort.signal, `System ${role}`, 120000);
    return item;
  }
  try {
    if (logOutput !== 'stream') log = await logFile(stateDir);
    const ports = [definition.factory.port, ...definition.productionLines.flatMap(line => [line.orchestrator.port, ...Array.from({ length: line.workers.count }, (_, index) => line.workers.statusPort + index)])];
    for (const port of ports) { abort.signal.throwIfAborted(); await freePort(port); }
    control = await createControl({ runId, controlToken, snapshot, stop }); await persist(); event('starting', snapshot());
    // Separate processes preserve each line's existing ownership, journal and credential boundary.
    for (const line of definition.productionLines) await launch('line', line.id, { stateDir: join(stateDir, 'lines', line.id) });
    const factory = await launch('factory', definition.factory.id, { stateDir, port: definition.factory.port, credentials,
      managedRegistry: { factories: [definition.factory.id, ...definition.factory.subFactories.map(factory => factory.id)], lines: definition.productionLines.map(line => line.id) } });
    await waitFor(async () => (await factoryRequest(snapshot().url, credentials.adminToken, '/v1/factories', { signal: abort.signal })).status === 200,
      () => !factory.closed, abort.signal, 'Authenticated Factory');
    await bootstrapSystem(definition, credentials, { signal: abort.signal });
    abort.signal.throwIfAborted(); state = 'running'; event('ready', { ...snapshot(), definition: plan });
    if (!noOpen) event('browser', await opener(snapshot().url));
    await ended;
  } catch (error) { if (!abort.signal.aborted) failure ??= error; }
  finally {
    await stop();
    if (control) await new Promise(resolve => { control.close(resolve); control.closeAllConnections(); });
    process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal);
    if (children.every(item => item.closed)) for (const path of [recordPath, lock]) {
      try { if ((await readPrivate(path)).runId === runId) await unlink(path); } catch (error) { if (error.code !== 'ENOENT') failure ??= error; }
    }
    event('stopped', { state: 'stopped', mode: plan.mode });
    await logging; await log?.close();
  }
  if (failure) throw failure;
  return { state: 'stopped' };
}
