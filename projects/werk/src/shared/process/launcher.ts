import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { windowsContainment } from './windows-containment.js';

/**
 * The only place application code starts child processes. Every launch:
 * - never opens a console window on Windows (a detached service has none to share);
 * - leads its own process group on POSIX, so termination reaches descendants;
 * - receives exactly the environment the caller built, never an implicit inheritance.
 * `contained` additionally runs the executable inside a kill-on-close Windows job.
 */
export type LaunchMode = 'plain' | 'contained';
export interface LaunchOptions { cwd?: string; env: NodeJS.ProcessEnv; mode?: LaunchMode; }

export function launchProcess(executable: string, args: string[], options: LaunchOptions): ChildProcessWithoutNullStreams {
  if (executable.includes('\0') || args.some(arg => arg.includes('\0'))) throw new TypeError('Process executable and arguments cannot contain NUL');
  const windows = process.platform === 'win32';
  const plan = windows && options.mode === 'contained' ? windowsContainment(executable, args, options.env) : { executable, args, env: options.env };
  return spawn(plan.executable, plan.args, { cwd: options.cwd, env: plan.env, detached: !windows, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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

/** Run to completion with a deadline, cancellation and bounded output. */
export function runProcess(executable: string, args: string[], options: RunOptions): Promise<RunResult> {
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
    child.once('close', code => {
      if (deadline) clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', cancel);
      terminateProcess(child, 'SIGKILL');
      const result = { exitCode: code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (signal?.aborted) failure = 'cancelled';
      if (!failure && code !== 0 && !options.allowNonZeroExit) failure = 'exit';
      if (failure) reject(new ProcessRunError(failure, result)); else resolve(result);
    });
  });
}
