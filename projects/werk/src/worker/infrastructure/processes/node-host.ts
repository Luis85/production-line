import { fileURLToPath } from 'node:url';
import { launchProcess } from '../../../shared/process/launcher.js';
import type { ServiceExit, ServiceHostEvent, ServiceHostPort, ServiceStopReason } from '../../application/process-supervision.js';

function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const environment = () => Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
/** Control and observations use private pipes; only a host's actual close acknowledges containment. */
export function nodeServiceHost(directory: string): ServiceHostPort {
  return { async start(input) {
    const host = launchProcess(process.execPath, [fileURLToPath(new URL('./service-host.js', import.meta.url))], { cwd: directory, env: environment(), mode: 'contained', observation: 'ignore' });
    const ready = deferred<void>(), ended = deferred<ServiceExit>();
    let buffer = '', reported: ServiceExit | undefined, started = false, settled = false, requested: ServiceStopReason | undefined;
    const timeout = setTimeout(() => { host.stdin.end(); ready.reject(Error('The private service host did not acknowledge startup.')); }, 15000); timeout.unref();
    host.stdout.setEncoding('utf8');
    host.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 262144) { host.stdin.end(); buffer = ''; return; }
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try {
          const event = JSON.parse(line) as ServiceHostEvent | { type: 'started' } | { type: 'exit'; value: ServiceExit };
          if (event.type === 'started') { started = true; clearTimeout(timeout); ready.resolve(); }
          else if (event.type === 'exit') reported = event.value;
          else if (event.type === 'output' || event.type === 'measurement') input.onEvent(event);
        } catch { host.stdin.end(); }
      }
    });
    // Host diagnostics are not payload output and may include private paths. Always drain them.
    host.stderr.resume(); host.stdin.on('error', () => {});
    host.once('error', () => { clearTimeout(timeout); ready.reject(Error('The private service host could not start.')); });
    host.once('close', () => {
      settled = true; clearTimeout(timeout);
      const exit = reported ?? { code: null, reason: 'host_lost' };
      if (!started) ready.reject(Error('The approved service could not start.'));
      ended.resolve(exit);
    });
    host.stdin.write(JSON.stringify({ preset: input.preset, scope: input.scope, expiresAt: input.expiresAt }) + '\n');
    try { await ready.promise; } catch (error) { host.stdin.end(); await ended.promise; throw error; }
    return { closed: ended.promise, async stop(reason) { if (!settled && !requested) { requested = reason; host.stdin.write(JSON.stringify({ action: 'stop', reason }) + '\n'); host.stdin.end(); } await ended.promise; } };
  } };
}
