import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { observeProcessFailure, observeProcessLaunch, type ProcessPurpose } from './observation.js';
import { windowsContainment } from './windows-containment.js';
import { WindowsSupervisorCache } from './windows-supervisor-cache.js';

const supervisorCache = process.platform === 'win32' ? new WindowsSupervisorCache() : undefined;
let preparationOwners = 0;
/** Trusted Windows setup only; every caller retains its shorter invocation or command deadline. */
const PROCESS_RUNTIME_PREPARATION_TIMEOUT_MS = 45000;

/**
 * The only place application code starts child processes. Every launch:
 * - never opens a console window on Windows (a detached service has none to share);
 * - leads its own process group on POSIX, so termination reaches descendants;
 * - receives exactly the environment the caller built, never an implicit inheritance.
 * `contained` additionally runs the executable inside a kill-on-close Windows job.
 */
export type LaunchedProcess = ChildProcessWithoutNullStreams;
export type LaunchMode = 'plain' | 'contained';
export interface LaunchOptions {
  cwd?: string; env: NodeJS.ProcessEnv; mode?: LaunchMode;
  /** Inherit is reserved for trusted service-host payloads whose host already owns containment. */
  processGroup?: 'new' | 'inherit';
  /** Probes and service internals opt out. Display metadata must never include command details. */
  observation?: 'ignore' | ProcessPurpose;
  /** A contained cmd.exe receives its command text verbatim. Only for arguments that are entirely operator-fixed; model-supplied text must never reach cmd.exe parsing. */
  verbatimCmd?: boolean;
}

export function launchProcess(executable: string, args: string[], options: LaunchOptions): ChildProcessWithoutNullStreams {
  if (executable.includes('\0') || args.some(arg => arg.includes('\0'))) throw new TypeError('Process executable and arguments cannot contain NUL');
  const windows = process.platform === 'win32';
  const plan = windows && options.mode === 'contained'
    ? supervisorCache?.plan(executable, args, options.env, options.cwd ?? process.cwd(), options.verbatimCmd === true) ?? windowsContainment(executable, args, options.env, options.verbatimCmd === true)
    : { executable, args, env: options.env };
  const child = spawn(plan.executable, plan.args, { cwd: options.cwd, env: plan.env, detached: !windows && options.processGroup !== 'inherit', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  if (options.observation !== 'ignore') observeProcessLaunch(child, !windows && options.processGroup !== 'inherit', options.observation);
  return child;
}

/**
 * Stop a launched process and its descendants. POSIX signals the whole group, also
 * after the leader exited so stragglers cannot outlive it. On Windows a contained
 * supervisor closes its job when killed; a plain child is terminated directly, and
 * never after exit, when its PID may already belong to another process.
 */
export function terminateProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals = 'SIGKILL') {
  if (!child.pid) return;
  if (process.platform !== 'win32') { try { process.kill(-child.pid, signal); } catch { /* Group already exited. */ } return; }
  if (child.exitCode === null && child.signalCode === null) try { child.kill(signal); } catch { /* Already exited. */ }
}

export type ProcessFailure = 'spawn' | 'timeout' | 'cancelled' | 'output_limit' | 'exit';
export interface RunResult { exitCode: number | null; stdout: Buffer; stderr: Buffer; }
/** Carries whatever output was captured so callers can still record telemetry after a failure. */
export class ProcessRunError extends Error {
  readonly reason: ProcessFailure; readonly result: RunResult;
  constructor(reason: ProcessFailure, result: RunResult) { super(`Process ${reason === 'exit' ? `exited with ${result.exitCode}` : reason}`); this.reason = reason; this.result = result; }
}
export interface RunOptions extends LaunchOptions {
  /** Combined stdout+stderr bytes before the process is stopped as output_limit. */
  maxOutputBytes: number;
  signal?: AbortSignal; timeoutMs?: number; input?: string | Buffer;
  /** Delay between SIGTERM and SIGKILL when stopping; 0 kills immediately. */
  graceMs?: number;
  captureStdout?: boolean; captureStderr?: boolean;
  /** Resolve on any exit code instead of rejecting with reason "exit". */
  allowNonZeroExit?: boolean;
}

/** Read-only preparation state; it never implies provider authentication or readiness. */
export function processRuntimePreparing(): boolean { return preparationOwners > 0; }

/** Explicit lifecycle-owned setup. It runs no provider command and never extends a command's deadline. */
export async function prepareProcessRuntime(cwd: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!supervisorCache) return;
  const stop = new AbortController(), bounded = AbortSignal.any([signal, stop.signal]);
  const timer = setTimeout(() => stop.abort(), PROCESS_RUNTIME_PREPARATION_TIMEOUT_MS); timer.unref();
  preparationOwners++;
  try { await prepareWindowsSupervisor(cwd, bounded); bounded.throwIfAborted(); }
  finally { clearTimeout(timer); preparationOwners--; }
}

async function prepareWindowsSupervisor(cwd: string, signal: AbortSignal): Promise<void> {
  await supervisorCache?.prepare(async (plan, bounded) => {
    // Private path bypasses cache preparation, while the existing supervisor contains the compiler.
    await runUnpreparedProcess(plan.executable, plan.args, { cwd: plan.cwd, env: plan.env, mode: 'contained', observation: 'ignore', input: plan.input,
      signal: bounded, timeoutMs: PROCESS_RUNTIME_PREPARATION_TIMEOUT_MS, maxOutputBytes: 131072, captureStderr: true, graceMs: 0 });
  }, cwd, signal);
}

/** Run to completion with a deadline, cancellation and bounded output. */
export async function runProcess(executable: string, args: string[], options: RunOptions): Promise<RunResult> {
  if (!supervisorCache || options.mode !== 'contained' || executable.includes('\0') || args.some(arg => arg.includes('\0'))) return runUnpreparedProcess(executable, args, options);
  args = [...args]; options = { ...options, env: { ...options.env } };
  const started = performance.now(), timeout = new AbortController();
  const deadline = options.timeoutMs === undefined ? undefined : setTimeout(() => timeout.abort(), options.timeoutMs);
  deadline?.unref();
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  const interrupted = () => new ProcessRunError(options.signal?.aborted ? 'cancelled' : 'timeout', { exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  try {
    await prepareWindowsSupervisor(options.cwd ?? process.cwd(), signal);
  } catch (error) { if (signal.aborted) throw interrupted(); throw error; }
  finally { if (deadline) clearTimeout(deadline); }
  if (signal.aborted) throw interrupted();
  const remaining = options.timeoutMs === undefined ? undefined : Math.ceil(options.timeoutMs - (performance.now() - started));
  if (remaining !== undefined && remaining <= 0) throw interrupted();
  return runUnpreparedProcess(executable, args, { ...options, timeoutMs: remaining });
}

/** Raw launch path is also the bounded bootstrap port; it never recursively prepares itself. */
function runUnpreparedProcess(executable: string, args: string[], options: RunOptions): Promise<RunResult> {
  const { signal, timeoutMs, input, graceMs = 1000, captureStdout = true, captureStderr = false } = options;
  const empty = (): RunResult => ({ exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  if (signal?.aborted) return Promise.reject(new ProcessRunError('cancelled', empty()));
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try { child = launchProcess(executable, args, options); }
    catch { reject(new ProcessRunError('spawn', empty())); return; }
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, failure: ProcessFailure | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: ProcessFailure) => {
      failure ??= reason;
      observeProcessFailure(child);
      if (graceMs <= 0) { terminateProcess(child, 'SIGKILL'); return; }
      terminateProcess(child, 'SIGTERM');
      killTimer ??= setTimeout(() => terminateProcess(child, 'SIGKILL'), graceMs);
      killTimer.unref();
    };
    const deadline = timeoutMs === undefined ? undefined : setTimeout(() => stop('timeout'), timeoutMs);
    deadline?.unref();
    const cancel = () => stop('cancelled');
    signal?.addEventListener('abort', cancel, { once: true });
    const collect = (chunk: Buffer, target: Buffer[], keep: boolean) => {
      bytes += chunk.length;
      if (bytes > options.maxOutputBytes) stop('output_limit');
      else if (keep) target.push(chunk);
    };
    child.stdout.on('data', chunk => collect(chunk, stdout, captureStdout));
    child.stderr.on('data', chunk => collect(chunk, stderr, captureStderr));
    child.stdin.on('error', () => { /* A child may exit without reading its input. */ });
    child.stdin.end(input);
    child.once('error', () => { failure ??= 'spawn'; });
    // An exited leader can leave descendants holding its output pipes open. Stop
    // the group on exit so close can drain captured output and settle the run.
    // Windows contained launches already drain their job inside the supervisor.
    child.once('exit', () => terminateProcess(child, 'SIGKILL'));
    child.once('close', code => {
      if (deadline) clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', cancel);
      const result = { exitCode: code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (signal?.aborted) failure = 'cancelled';
      if (!failure && code !== 0 && !options.allowNonZeroExit) failure = 'exit';
      if (failure) reject(new ProcessRunError(failure, result)); else resolve(result);
    });
  });
}
