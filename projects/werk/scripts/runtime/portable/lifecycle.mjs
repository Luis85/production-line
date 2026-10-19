import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { open, unlink, lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep, dirname, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { privateDirectory, readPrivate, createPrivate, inputError } from '../config.mjs';
import { controlRequest, createControl } from '../control.mjs';
import { configuredProjectRoot } from './project.mjs';
import { runComponent } from '../component.mjs';

const metadataPath = state => join(state, 'portable.json');
async function record(kind, state) {
  const value = await readPrivate(metadataPath(state));
  if (value.kind !== kind) throw inputError('State belongs to another application. Choose a separate --state-dir.');
  return value;
}
/** A missing state file. A state path that is a file makes POSIX report ENOTDIR for its entries: nothing runs from it either. */
export const stateAbsent = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
export async function status(kind, state) {
  let value;
  try { value = await record(kind, state); }
  catch (error) {
    if (!stateAbsent(error)) throw error;
    for (const name of ['worker.lock', 'runtime.lock']) {
      if (await lstat(join(state, name)).catch(error => { if (!stateAbsent(error)) throw error; })) return { state: 'unreachable', kind, stateDirectory: state, action: 'Startup may be in progress. After a crash, verify the old process has exited before removing its lock.' };
    }
    return { state: 'stopped', kind, stateDirectory: state };
  }
  try { return { ...await controlRequest(value), kind, stateDirectory: state, credentialsFile: join(state, kind === 'worker' ? 'webview-token' : 'component.json') }; }
  catch { return { state: 'unreachable', kind, stateDirectory: state, action: 'Control identity could not be verified. No PID was signalled. Inspect private state and verify the old process has exited before removing portable.json and its application lock.' }; }
}
export async function stop(kind, state) {
  const before = await status(kind, state);
  if (before.state === 'stopped') return before;
  if (before.state === 'unreachable') throw inputError(before.action);
  const identity = await record(kind, state);
  await controlRequest(identity, 'stop');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const next = await status(kind, state);
    if (next.state === 'stopped') return next;
    // A new instance is never stopped by a command for the previous run.
    const current = await record(kind, state).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (current && current.runId !== identity.runId) return { state: 'stopped', kind, runId: identity.runId };
    await delay(100);
  }
  throw Error('Shutdown is still in progress. Inspect status and logs before retrying.');
}
export async function start(kind, state, root, args) {
  const before = await status(kind, state);
  if (before.state === 'running') throw inputError('Already running. Use status, or stop before changing launch options.');
  if (before.state !== 'stopped') throw inputError(before.action ?? 'Application is stopping.');
  await privateDirectory(state);
  const logPath = join(state, 'portable.log');
  // Refuse links before opening a process log; credentials and state stay private.
  const prior = await lstat(logPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (prior && (!prior.isFile() || prior.isSymbolicLink() || (process.platform !== 'win32' && prior.mode & 0o077))) throw inputError('portable.log must be a private regular file.');
  const log = await open(logPath, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [join(root, 'cli.mjs'), '_run', ...args], { cwd: process.cwd(), env: process.env, detached: true, stdio: ['ignore', log.fd, log.fd, 'ipc'], windowsHide: true });
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return; settled = true;
        clearTimeout(timer); child.removeListener('exit', exited); child.removeListener('error', failed);
        if (error) { child.send?.({ action: 'stop' }, () => {}); reject(error); }
        else { child.disconnect(); child.unref(); resolve(value); }
      };
      const exited = () => finish(Error(`Startup failed. Inspect ${logPath}.`));
      const failed = () => finish(Error(`Could not launch Node. Inspect ${logPath}.`));
      const timer = setTimeout(() => finish(Error(`Startup deadline exceeded. Shutdown requested; inspect ${logPath}.`)), 25000);
      child.once('error', failed); child.once('exit', exited);
      child.once('message', value => value?.ok ? finish(null, value.data) : finish(inputError(value?.error ?? 'Startup failed.')));
    });
  } finally { await log.close(); }
}
async function canonicalDestination(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalDestination(parent), basename(path));
  }
}
export async function stateDirectory(kind, root, value) {
  const state = resolve(value ?? `.werk/${kind}`);
  const selected = await lstat(state).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (selected?.isSymbolicLink()) throw inputError('State must be a real private directory, not a symlink.');
  // Resolve existing ancestors before comparing a not-yet-created destination.
  // macOS /var aliases and Windows junctions must not bypass app/state separation.
  const canonicalRoot = await realpath(root), canonicalState = await canonicalDestination(state);
  const fold = path => process.platform === 'win32' ? path.toLowerCase() : path;
  const inside = relative(fold(canonicalRoot), fold(canonicalState));
  if (!inside || (inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside))) throw inputError('Keep --state-dir outside the copied app folder so upgrades preserve state.');
  // Normalize caller-owned ancestors once; managed child directories retain strict link checks.
  return canonicalState;
}
export async function run(kind, state, root, options, internal, launch = null) {
  const before = await status(kind, state);
  if (before.state !== 'stopped') throw inputError(before.action ?? 'Application already running.');
  const abort = new AbortController();
  let control, closeService, worker, closing, identity, ready = false;
  const close = () => closing ??= (async () => {
    abort.abort();
    await closeService?.();
    await worker?.catch(() => {});
    if (control) await new Promise(resolve => { control.close(resolve); control.closeAllConnections(); });
    if (identity) {
      const current = await record(kind, state).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (current?.runId === identity.runId) await unlink(metadataPath(state));
    }
  })();
  const onSignal = () => { void close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
  if (internal) {
    process.on('message', value => { if (value?.action === 'stop') onSignal(); });
    process.once('disconnect', () => { if (!ready) onSignal(); });
  }
  const onReady = async (info, closer) => {
    closeService = closer;
    abort.signal.throwIfAborted();
    const endpoint = new URL(info.url);
    if (['0.0.0.0', '[::]'].includes(endpoint.hostname)) { endpoint.hostname = '127.0.0.1'; info = { ...info, url: endpoint.origin }; }
    const runId = randomBytes(32).toString('hex'), controlToken = randomBytes(32).toString('hex');
    const snapshot = () => ({ state: closing ? 'stopping' : 'running', runId, project: options.project ?? null, mode: 'mixed', url: info.url, workers: kind === 'worker' ? 1 : 0 });
    control = await createControl({ runId, controlToken, snapshot, stop: onSignal });
    identity = { schemaVersion: 1, kind, runId, controlToken, pid: process.pid, controlPort: control.address().port, children: [], url: info.url, ...(launch ? { launch } : {}) };
    await createPrivate(metadataPath(state), identity);
    const data = { ...snapshot(), kind, stateDirectory: state, credentialsFile: info.credentialsFile };
    ready = true;
    if (internal) process.send?.({ ok: true, data }); else console.log(JSON.stringify(data));
  };
  try {
    if (kind === 'worker') {
      for (const name of ['component.json', 'credentials.json', 'supervisor.json', 'docker-volume.json', 'config.json']) if (await lstat(join(state, name)).catch(error => { if (error.code !== 'ENOENT') throw error; })) throw inputError('State belongs to another runtime. Choose a separate worker directory.');
      const { runWorker } = await import(new URL(`../../../src/worker/dist/worker/runner.js`, import.meta.url));
      const { configuration } = await import(new URL(`../../../src/worker/dist/worker/config.js`, import.meta.url));
      const effective = await configuration(options);
      worker = runWorker({ ...effective, stateDir: state, url: options.url, enrollmentToken: process.env.WERK_ENROLLMENT_TOKEN ?? '', webviewToken: process.env.WERK_WORKER_TOKEN, projectDir: options['project-dir'], integrationProjectDir: await configuredProjectRoot(options), statusHost: options.host ?? '127.0.0.1', statusPort: Number(options.port ?? 4100) }, abort.signal, { ready: async address => {
        const host = address.address === '0.0.0.0' || address.address === '::' ? '127.0.0.1' : address.address;
        await onReady({ url: `http://${host.includes(':') ? '[' + host + ']' : host}:${address.port}`, credentialsFile: join(state, 'webview-token') });
      } });
      await worker;
      await close();
    } else {
      await runComponent(kind, Object.entries({ 'state-dir': state, host: options.host ?? '127.0.0.1', port: options.port ?? (kind === 'factory' ? '3100' : '3000'), ...(options.project ? { project: options.project } : {}) }).flatMap(([key, value]) => ['--' + key, value]), { ready: onReady, environmentLoaded: true });
    }
  } catch (error) { abort.abort(); await close().catch(() => {}); throw error; }
}
