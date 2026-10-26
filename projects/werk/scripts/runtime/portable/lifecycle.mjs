import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { open, unlink, lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep, dirname, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { privateDirectory, readPrivate, createPrivate, inputError } from '../config.mjs';
import { controlRequest, createControl } from '../control.mjs';
import { configuredProjectRoot } from './project.mjs';
import { runComponent } from '../component.mjs';
import { ownerStatus, recordOwner, recoverStale } from './stale-state.mjs';

const metadataPath = state => join(state, 'portable.json');
/** How long `start` waits for its detached `_run` child to report ready. */
const STARTUP_TIMEOUT_MS = 120000;
/** How long a failed start waits for the child to honour the IPC stop before it ends the child's process tree. */
export const STARTUP_GRACE_MS = 10000;
const KILL_WAIT_MS = 10000;
/** Loading the CLI and recovering the failed child's state, beyond the start's own waits. */
const CLI_LOAD_MARGIN_MS = 10000;
/** The longest a `start` with this deadline can take, failure cleanup included: deadline, IPC grace, then the tree kill and its exit wait. */
export const startupBudgetMs = timeoutMs => timeoutMs + STARTUP_GRACE_MS + 2 * KILL_WAIT_MS + CLI_LOAD_MARGIN_MS;
/** The startup deadline: `--startup-timeout-ms` wins over WERK_STARTUP_TIMEOUT_MS, then the default. */
export function startupTimeout(options = {}, environment = process.env) {
  const [name, value] = options['startup-timeout-ms'] !== undefined ? ['--startup-timeout-ms', options['startup-timeout-ms']] : ['WERK_STARTUP_TIMEOUT_MS', environment.WERK_STARTUP_TIMEOUT_MS];
  if (value === undefined) return STARTUP_TIMEOUT_MS;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 5000 || Number(value) > 900000) throw inputError(`${name}: integer 5000–900000`);
  return Number(value);
}
const exitWithin = (child, ms) => new Promise(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
  const done = value => { clearTimeout(timer); child.removeListener('exit', exited); resolve(value); };
  const exited = () => done(true), timer = setTimeout(() => done(false), ms);
  child.once('exit', exited);
});
/** Ends only the child's own process tree, never processes selected by image name. */
function killTree(child) {
  if (process.platform === 'win32') return new Promise(resolve => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: KILL_WAIT_MS }, () => resolve()));
  // A detached child leads its own process group, which includes its providers.
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}
/** Stops a child that failed to start: IPC stop, a bounded grace period, then its process tree. Resolves whether it exited. */
async function stopLaunched(kind, state, options, child) {
  // A signal that cannot be delivered shows as a child that did not exit.
  child.on('error', () => {});
  if (child.connected) child.send({ action: 'stop' }, () => {});
  let stopped = !child.pid || await exitWithin(child, STARTUP_GRACE_MS);
  if (!stopped) { await killTree(child); stopped = await exitWithin(child, KILL_WAIT_MS); }
  if (child.connected) child.disconnect();
  child.unref();
  // A killed child leaves the portable.json and lock it wrote; stale recovery removes them once its PID is proven gone.
  if (stopped) await settled(kind, state, options).catch(() => {});
  return stopped;
}
async function record(kind, state) {
  const value = await readPrivate(metadataPath(state));
  if (value.kind !== kind) throw inputError('State belongs to another application. Choose a separate --state-dir.');
  return value;
}
/** A missing state file. A state path that is a file makes POSIX report ENOTDIR for its entries: nothing runs from it either. */
export const stateAbsent = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
/** `options` locate the project worker's feature folder, whose lock a stale status also lists. */
export async function status(kind, state, options = {}) {
  let value;
  try { value = await record(kind, state); }
  catch (error) {
    if (!stateAbsent(error)) throw error;
    for (const name of ['worker.lock', 'runtime.lock']) {
      if (await lstat(join(state, name)).catch(error => { if (!stateAbsent(error)) throw error; })) return ownerStatus(kind, state, options, join(state, name), 'Startup may be in progress. After a crash, verify the old process has exited before removing its lock.');
    }
    return { state: 'stopped', kind, stateDirectory: state };
  }
  try { return { ...await controlRequest(value), kind, stateDirectory: state, credentialsFile: join(state, kind === 'worker' ? 'webview-token' : 'component.json') }; }
  catch { return ownerStatus(kind, state, options, metadataPath(state), 'Control identity could not be verified. No PID was signalled. Inspect private state and verify the old process has exited before removing portable.json and its application lock.'); }
}
/** Status after removing files a provably dead owner left: start, run and stop then proceed as if stopped. */
async function settled(kind, state, options) {
  const value = await status(kind, state, options);
  return value.state === 'stale' ? { state: 'stopped', kind, stateDirectory: state, recovered: await recoverStale(value) } : value;
}
export async function stop(kind, state, options = {}) {
  const before = await settled(kind, state, options);
  if (before.state === 'stopped') return before;
  if (before.state === 'unreachable') throw inputError(before.action);
  const identity = await record(kind, state);
  await controlRequest(identity, 'stop');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const next = await settled(kind, state, options);
    if (next.state === 'stopped') return next;
    // A new instance is never stopped by a command for the previous run.
    const current = await record(kind, state).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (current && current.runId !== identity.runId) return { state: 'stopped', kind, runId: identity.runId };
    await delay(100);
  }
  throw Error('Shutdown is still in progress. Inspect status and logs before retrying.');
}
export async function start(kind, state, root, args, options = {}) {
  const timeout = startupTimeout(options), before = await settled(kind, state, options);
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
    // The deadline belongs to this launcher; `_run` does not accept it.
    const launch = args.filter((value, index) => value !== '--startup-timeout-ms' && args[index - 1] !== '--startup-timeout-ms');
    child = spawn(process.execPath, [join(root, 'cli.mjs'), '_run', ...launch], { cwd: process.cwd(), env: process.env, detached: true, stdio: ['ignore', log.fd, log.fd, 'ipc'], windowsHide: true });
    return await new Promise((resolve, reject) => {
      let settled = false;
      // `failure` builds the error from the outcome of stopping the child.
      const outcome = stopped => stopped ? `the ${kind} process was stopped` : `the ${kind} process (PID ${child.pid}) could not be stopped; end that PID before retrying`;
      const finish = (failure, value) => {
        if (settled) return; settled = true;
        clearTimeout(timer); child.removeListener('exit', exited); child.removeListener('error', failed); child.removeListener('disconnect', dropped);
        if (failure) stopLaunched(kind, state, options, child).then(stopped => reject(failure(stopped)), reject);
        else { child.disconnect(); child.unref(); resolve(value); }
      };
      const exited = () => finish(() => Error(`Startup failed. Inspect ${logPath}.`));
      const failed = () => finish(() => Error(`Could not launch Node. Inspect ${logPath}.`));
      const dropped = () => finish(stopped => Error(`Startup failed; ${outcome(stopped)}. Inspect ${logPath}.`));
      const timer = setTimeout(() => finish(stopped => Error(`Startup deadline (${timeout / 1000} s) exceeded; ${outcome(stopped)}. Inspect ${logPath}. On a busy host retry with --startup-timeout-ms 300000.`)), timeout);
      child.once('error', failed); child.once('exit', exited); child.once('disconnect', dropped);
      child.once('message', value => value?.ok ? finish(null, value.data) : finish(stopped => inputError(stopped ? value?.error ?? 'Startup failed.' : `${value?.error ?? 'Startup failed.'} Afterwards ${outcome(false)}. Inspect ${logPath}.`)));
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
  const before = await settled(kind, state, options);
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
    identity = { schemaVersion: 1, kind, runId, controlToken, ...await recordOwner(kind), controlPort: control.address().port, children: [], url: info.url, ...(launch ? { launch } : {}) };
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
      if (options['home-dir'] !== undefined && (!isAbsolute(options['home-dir']) || await realpath(options['home-dir']) !== options['home-dir'])) throw inputError('Home must be an explicit canonical absolute directory from the Home launcher.');
      worker = runWorker({ ...effective, stateDir: state, ...(options['home-dir'] ? { homeDir: options['home-dir'] } : {}), url: options.url, enrollmentToken: process.env.WERK_ENROLLMENT_TOKEN ?? '', webviewToken: process.env.WERK_WORKER_TOKEN, projectDir: options['project-dir'], integrationProjectDir: options['home-dir'] ? undefined : await configuredProjectRoot(options), statusHost: options.host ?? '127.0.0.1', statusPort: Number(options.port ?? 4100) }, abort.signal, { ready: async address => {
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
