import { fileURLToPath } from 'node:url';
import { launchProcess, terminateProcess } from '../../../shared/process/launcher.js';
import type { ServiceExit, ServiceHostEvent, ServiceHostPort, ServiceStopReason } from '../../application/process-supervision.js';

function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const environment = () => Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
interface HostOptions { launch?: typeof launchProcess; terminate?: typeof terminateProcess; startupTimeoutMs?: number; stopGraceMs?: number; cleanupTimeoutMs?: number; }
const bounded = (value: number | undefined, maximum: number) => value !== undefined && Number.isSafeInteger(value) ? Math.max(1, Math.min(value, maximum)) : maximum;
const cleanupError = () => Error('Service cleanup could not be confirmed. Its slot remains reserved. Inspect the worker process and retry Stop.');
/** Ownership transfers before startup. Only actual close settles containment; deadlines reject without releasing it. */
export function nodeServiceHost(directory: string, options: HostOptions = {}): ServiceHostPort {
  const startupMs = bounded(options.startupTimeoutMs, 15000), cleanupMs = bounded(options.cleanupTimeoutMs, 5000);
  const graceMs = Math.min(bounded(options.stopGraceMs, 1000), cleanupMs - 1);
  return { start(input) {
    const host = (options.launch ?? launchProcess)(process.execPath, [fileURLToPath(new URL('./service-host.js', import.meta.url))], { cwd: directory, env: environment(), mode: 'contained', observation: 'ignore' });
    const ready = deferred<void>(), ended = deferred<ServiceExit>();
    let buffer = '', reported: ServiceExit | undefined, acknowledged = false, settled = false, requested: ServiceStopReason | undefined;
    let attempt: Promise<void> | undefined, observedCleanup: Promise<void> | undefined;
    // A caller may need only closure after cancelling startup; retain the rejection on the public promise.
    void ready.promise.catch(() => {});
    const stop = (reason: ServiceStopReason): Promise<void> => {
      if (settled) return Promise.resolve();
      if (attempt) return attempt;
      clearTimeout(timeout);
      ready.reject(Error('The approved service could not start because its host stopped before acknowledging startup.'));
      if (!requested) {
        requested = reason;
        try { host.stdin.write(JSON.stringify({ action: 'stop', reason }) + '\n'); host.stdin.end(); } catch { /* Force the same owned handle if its input is unavailable. */ }
      }
      const stopping = new Promise<void>((resolve, reject) => {
        const force = setTimeout(() => {
          // After leader exit, undrained pipes no longer prove process-group ownership.
          if (!settled && host.exitCode === null && host.signalCode === null) try { (options.terminate ?? terminateProcess)(host); } catch { /* The deadline retains uncertain ownership. */ }
        }, graceMs);
        const deadline = setTimeout(() => reject(cleanupError()), cleanupMs);
        const clear = () => { clearTimeout(force); clearTimeout(deadline); };
        void ended.promise.then(() => { clear(); resolve(); });
      });
      attempt = stopping;
      void stopping.finally(() => { if (attempt === stopping) attempt = undefined; }).catch(() => {});
      return stopping;
    };
    const cleanup = (reason: ServiceStopReason) => {
      const operation = stop(reason);
      if (operation === observedCleanup) return;
      observedCleanup = operation;
      void operation.catch(() => { if (!settled) try { input.onEvent({ type: 'cleanup_unconfirmed', reason }); } catch { /* Ownership still remains with the caller. */ } });
    };
    const timeout = setTimeout(() => { ready.reject(Error('The private service host did not acknowledge startup.')); cleanup('startup_timeout'); }, startupMs);
    host.stdout.setEncoding('utf8');
    host.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 262144) { buffer = ''; cleanup('storage_failed'); return; }
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try {
          const event = JSON.parse(line) as ServiceHostEvent | { type: 'started' } | { type: 'exit'; value: ServiceExit };
          if (event.type === 'started' && !requested) { acknowledged = true; clearTimeout(timeout); ready.resolve(); }
          else if (event.type === 'exit') { reported = event.value; cleanup('shutdown'); }
          else if (event.type === 'output' || event.type === 'measurement') input.onEvent(event);
        } catch { cleanup('storage_failed'); }
      }
    });
    // Host diagnostics are not payload output and may include private paths. Always drain them.
    host.stderr.resume(); host.stdin.on('error', () => {});
    host.once('error', () => { ready.reject(Error('The private service host could not start.')); cleanup('storage_failed'); });
    host.once('close', () => {
      settled = true; clearTimeout(timeout);
      if (!acknowledged) ready.reject(Error('The approved service could not start.'));
      ended.resolve(reported ?? { code: null, reason: 'host_lost' });
    });
    try { host.stdin.write(JSON.stringify({ preset: input.preset, scope: input.scope, expiresAt: input.expiresAt }) + '\n'); }
    catch { ready.reject(Error('The private service host could not start.')); cleanup('storage_failed'); }
    return { started: ready.promise, closed: ended.promise, stop };
  } };
}
