import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { open, rename, unlink, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { releaseRoot, loadSetup, privateDirectory, createPrivate, readPrivate, inputError } from './config.mjs';
import { createControl } from './control.mjs';
import { checkArtifacts, freePort, orchestratorReady, workerReady, waitFor } from './health.mjs';
import { openBrowser } from './browser.mjs';
import { captureServiceLogs, logOutputMode } from './service-logs.mjs';

const timeout = (promise, milliseconds) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('Owned child did not stop before the shutdown deadline.')), milliseconds);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
export function runtimeEnvironment(environment, { liveProvider = false } = {}) {
  const allowed = new Set(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']);
  for (const name of ['WERK_ALERT_QUEUE_AGE_SECONDS', 'WERK_ALERT_FAILURE_WINDOW_SECONDS', 'WERK_ALERT_FAILED_ATTEMPTS', 'WERK_ALERT_OUTBOX_AGE_SECONDS', 'WERK_ALERT_OUTBOX_PENDING', 'WERK_ALERT_STALE_OBSERVATION_SECONDS']) {
    const value = environment[name];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !/^[1-9][0-9]{0,7}$/.test(value) || Number(value) > 8640000) throw inputError(name + ': integer 1–8640000 required.');
    allowed.add(name);
  }
  // Only an explicitly configured live worker receives provider runtime context.
  // Preserve managed Codex guards; task shell commands still inherit no environment.
  if (liveProvider) for (const name of Object.keys(environment)) {
    if (name.startsWith('CODEX_') || ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'OPENAI_CLUSTER'].includes(name)) allowed.add(name);
  }
  return Object.fromEntries(Object.entries(environment).filter(([name, value]) => allowed.has(name) && typeof value === 'string'));
}
async function replacePrivate(path, value) {
  const temporary = path + '.' + randomBytes(8).toString('hex');
  await createPrivate(temporary, value);
  try { await rename(temporary, path); } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function logFile(stateDir) {
  const directory = join(stateDir, 'logs'); await privateDirectory(directory);
  const path = join(directory, 'runtime.jsonl'), limit = 1048576;
  let size = 0;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) throw inputError('Runtime log must be a private regular file.');
    size = info.size;
    if (size >= limit) { await rename(path, path + '.previous'); size = 0; }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);
  let handle = await open(path, flags, 0o600), writes = Promise.resolve(), closed = false;
  return {
    appendFile(content) {
      if (closed) return Promise.reject(Error('Runtime log is closed.'));
      const bytes = Buffer.byteLength(content);
      if (bytes > limit) return Promise.reject(Error('Runtime log record exceeds its bound.'));
      const next = writes.then(async () => {
        if (size + bytes > limit) {
          await handle.close(); await rename(path, path + '.previous'); handle = await open(path, flags, 0o600); size = 0;
        }
        await handle.appendFile(content); size += bytes;
      });
      writes = next.catch(() => {}); return next;
    },
    async close() { closed = true; await writes; await handle.close(); },
  };
}
export async function startRuntime(stateDir, { noOpen = false, emit = () => {}, opener = openBrowser, environment = process.env, signal: externalSignal, logOutput = 'file' } = {}) {
  logOutput = logOutputMode(logOutput);
  const { config, credentials } = await loadSetup(stateDir);
  if (config.runtime !== 'native') throw inputError('This state belongs to Docker. Use werk-docker for its lifecycle; do not open the same databases with native start.');
  await checkArtifacts();
  const runId = randomBytes(32).toString('hex'), controlToken = randomBytes(32).toString('hex');
  const lock = join(stateDir, 'runtime.lock'), recordPath = join(stateDir, 'supervisor.json');
  try { await lstat(recordPath); throw inputError('Supervisor metadata already exists. Use status/stop, or verify stale ownership before recovery.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await createPrivate(lock, { schemaVersion: 1, runId, pid: process.pid }); }
  catch (error) { if (error.code === 'EEXIST') throw inputError('Runtime lock already exists. Use status/stop for its owner. After a crash, verify all owned processes exited before removing stale metadata; never signal an unverified stored PID.'); throw error; }
  const children = [], abort = new AbortController(); let state = 'starting', control, log, stopPromise, failure, finish;
  const ended = new Promise(resolve => { finish = resolve; });
  const snapshot = () => ({ state, runId, project: config.project, mode: config.mode, url: `http://127.0.0.1:${config.orchestratorPort}/`,
    workers: Array.from({ length: config.workers }, (_, n) => ({ index: n + 1, url: `http://127.0.0.1:${config.workerPort + n}/` })) });
  let logging = Promise.resolve();
  function event(event, details = {}) {
    const value = { event, ...details };
    emit(value);
    if (log) logging = logging.then(() => log.appendFile(JSON.stringify({ time: new Date().toISOString(), ...value }) + '\n')).catch(() => {});
  }
  async function persist() {
    if (!control) return;
    await replacePrivate(recordPath, { schemaVersion: 1, runId, pid: process.pid, controlPort: control.address().port, controlToken,
      children: children.filter(item => item.child.pid).map(item => ({ pid: item.child.pid, role: item.role, index: item.index })) });
  }
  async function drain(items, graceMs) {
    for (const item of items) if (!item.closed && item.child.connected) item.child.send({ command: 'stop' }, () => {});
    try { await timeout(Promise.all(items.map(item => item.completion)), graceMs); }
    catch {
      for (const item of items) if (!item.closed) item.child.kill('SIGKILL');
      await timeout(Promise.all(items.map(item => item.completion)), 3000);
    }
  }
  function stop() {
    if (stopPromise) return stopPromise;
    state = 'stopping'; abort.abort(); event('stopping', snapshot());
    stopPromise = (async () => {
      try { await drain(children.filter(item => item.role === 'worker'), 12000); }
      catch (error) { failure ??= error; }
      finally { await drain(children.filter(item => item.role === 'orchestrator'), 6000); }
    })().catch(error => { failure ??= error; }).finally(finish);
    return stopPromise;
  }
  const signal = () => { void stop(); };
  externalSignal?.addEventListener('abort', signal, { once: true });
  if (externalSignal?.aborted) signal();
  process.on('SIGINT', signal); process.on('SIGTERM', signal);
  async function launch(role, index = 0) {
    abort.signal.throwIfAborted();
    const child = spawn(process.execPath, [join(releaseRoot, 'scripts/runtime/child.mjs')], { cwd: releaseRoot, detached: process.platform !== 'win32', windowsHide: true,
      env: runtimeEnvironment(environment, { liveProvider: role === 'worker' && (config.mode === 'cli' || !!config.chat) }), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const item = { child, role, index, closed: false, completion: undefined };
    // Child diagnostics may contain provider/repository text. Only allowlisted lifecycle events
    // enter runtime output/logs; never relay arbitrary child stdout/stderr to public reports.
    captureServiceLogs(child.stderr, entry => event('service_log', { role, index, entry }));
    item.completion = new Promise(resolve => {
      child.once('error', () => { failure ??= Error(`${role} could not launch. Verify the complete release and Node 24 installation.`); void stop(); });
      child.once('close', (code, exitSignal) => {
        item.closed = true; event('child_exited', { role, index, exitCode: code, signal: exitSignal }); resolve();
        if (!stopPromise) { failure ??= Error(`${role} exited unexpectedly. Inspect configuration and restart the runtime after resolving the failure.`); void stop(); }
      });
    });
    children.push(item); await persist();
    if (child.connected) child.send({ command: 'start', role, index, config, stateDir,
      credentials: role === 'orchestrator' ? credentials : { WERK_ENROLLMENT_TOKEN: credentials.WERK_ENROLLMENT_TOKEN } }, () => {});
    return item;
  }
  try {
    abort.signal.throwIfAborted();
    if (logOutput !== 'stream') log = await logFile(stateDir);
    for (const port of [config.orchestratorPort, ...Array.from({ length: config.workers }, (_, n) => config.workerPort + n)]) await freePort(port);
    control = await createControl({ runId, controlToken, snapshot, stop }); await persist(); event('starting', snapshot());
    const orchestrator = await launch('orchestrator');
    await waitFor(() => orchestratorReady(config, credentials), () => !orchestrator.closed, abort.signal, 'Orchestrator');
    for (let index = 1; index <= config.workers; index++) {
      const worker = await launch('worker', index);
      await waitFor(() => workerReady(config, credentials, stateDir, index), () => !worker.closed, abort.signal, `Worker ${index}`);
    }
    abort.signal.throwIfAborted(); state = 'running'; event('ready', snapshot());
    if (!noOpen) { const browser = await opener(snapshot().url); event('browser', browser); }
    await ended;
  } catch (error) { if (!abort.signal.aborted) failure ??= error; }
  finally {
    await stop();
    if (control) await new Promise(resolve => { control.close(resolve); control.closeAllConnections(); });
    externalSignal?.removeEventListener('abort', signal);
    process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal);
    if (children.every(item => item.closed)) {
      try { const current = await readPrivate(recordPath); if (current.runId === runId) await unlink(recordPath); } catch (error) { if (error.code !== 'ENOENT') failure ??= error; }
      try { const current = await readPrivate(lock); if (current.runId === runId) await unlink(lock); } catch (error) { if (error.code !== 'ENOENT') failure ??= error; }
    }
    state = 'stopped'; event('stopped', { mode: config.mode }); await logging; await log?.close();
  }
  if (failure) throw failure;
  return { state: 'stopped' };
}
