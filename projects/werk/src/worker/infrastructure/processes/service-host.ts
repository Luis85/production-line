import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { launchProcess } from '../../../shared/process/launcher.js';
import type { ServiceExit, ServicePreset, ServiceScope, ServiceStopReason } from '../../application/process-supervision.js';
import { validateServicePreset, validateServiceScope } from '../../application/service-policy.js';
import { sampleOwnedProcessGroup } from './sampler.js';

type Payload = ReturnType<typeof launchProcess>;
let child: Payload | undefined, stopping = false, launched = false;
let sampleTimer: ReturnType<typeof setInterval> | undefined;
let ttlTimer: ReturnType<typeof setTimeout> | undefined;
const send = (value: unknown, done?: () => void) => process.stdout.write(JSON.stringify(value) + '\n', done);
const stopReasons: ServiceStopReason[] = ['operator', 'feature_ended', 'revoked', 'shutdown', 'ttl', 'startup_timeout', 'storage_failed'];
/** This live group leader owns the payload. Its stdin is a private lifetime lease from the worker. */
function finish(exit: ServiceExit) {
  if (stopping) return;
  stopping = true; if (sampleTimer) clearInterval(sampleTimer); if (ttlTimer) clearTimeout(ttlTimer);
  const killGroup = () => {
    if (process.platform === 'win32') { if (child && child.exitCode === null && child.signalCode === null) child.kill(); process.exit(0); }
    // A live host signals its own group, never a persisted PID or a re-adopted process.
    try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); }
  };
  const fallback = setTimeout(killGroup, 1000);
  send({ type: 'exit', value: exit }, () => {
    if (process.platform === 'win32') { clearTimeout(fallback); killGroup(); return; }
    try { process.kill(-process.pid, 'SIGTERM'); } catch { clearTimeout(fallback); killGroup(); }
  });
}
process.on('SIGTERM', () => { if (!stopping) finish({ code: null, reason: 'parent_lost' }); });
process.on('SIGINT', () => finish({ code: null, reason: 'parent_lost' }));
process.on('uncaughtException', () => finish({ code: null, reason: 'host_lost' }));
process.on('unhandledRejection', () => finish({ code: null, reason: 'host_lost' }));
process.stdout.on('error', () => finish({ code: null, reason: 'parent_lost' }));
const input = createInterface({ input: process.stdin });
input.once('close', () => finish({ code: null, reason: 'parent_lost' }));
const handshake = setTimeout(() => finish({ code: null, reason: 'parent_lost' }), 10000);
input.on('line', async line => {
  try {
    if (stopping) return;
    if (line.length > 131072) throw Error('Oversized service control frame.');
    const value = JSON.parse(line) as { preset?: ServicePreset; scope?: ServiceScope; expiresAt?: string; action?: string; reason?: ServiceStopReason };
    if (launched) { if (value.action === 'stop' && value.reason && stopReasons.includes(value.reason)) finish({ code: null, reason: value.reason }); return; }
    launched = true; clearTimeout(handshake);
    const preset = validateServicePreset(value.preset); validateServiceScope(value.scope!);
    const ttl = Date.parse(value.expiresAt ?? '') - Date.now();
    if (!preset.enabled || !Number.isFinite(ttl) || ttl <= 0 || ttl > preset.ttlMs + 1000) throw Error('Invalid service lifetime.');
    const scope = value.scope!, info = await lstat(scope.worktree);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(scope.worktree) !== resolve(scope.worktree)
      || String(info.dev) !== scope.worktreeIdentity.dev || String(info.ino) !== scope.worktreeIdentity.ino || info.birthtimeMs !== scope.worktreeIdentity.birthtimeMs) throw Error('The pinned service directory changed.');
    // EOF or stop may arrive while filesystem identity validation is pending.
    if (stopping) return;
    const remaining = Date.parse(value.expiresAt!) - Date.now();
    if (remaining <= 0) { finish({ code: null, reason: 'ttl' }); return; }
    // The host has already received a minimal environment; never add ambient credentials.
    child = launchProcess(preset.executable, preset.args, { cwd: value.scope!.worktree, env: { ...process.env }, mode: 'plain', processGroup: 'inherit', observation: 'ignore' });
    const payload = child;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const output = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      for (let offset = 0; offset < chunk.length; offset += 8192) if (!send({ type: 'output', stream, text: decoders[stream].write(chunk.subarray(offset, offset + 8192)) })) { payload.stdout.pause(); payload.stderr.pause(); }
    };
    process.stdout.on('drain', () => { payload.stdout.resume(); payload.stderr.resume(); });
    payload.stdout.on('data', chunk => output('stdout', chunk)); payload.stderr.on('data', chunk => output('stderr', chunk));
    payload.stdin.on('error', () => {}); payload.stdin.end();
    payload.once('error', () => finish({ code: null, reason: 'spawn_failed' }));
    payload.once('exit', code => finish({ code, reason: 'exit' }));
    payload.once('spawn', () => {
      send({ type: 'started' });
      const sample = async () => { const measurement = await sampleOwnedProcessGroup(process.pid); if (!stopping) send({ type: 'measurement', value: measurement }); };
      void sample(); sampleTimer = setInterval(() => { void sample(); }, 5000); sampleTimer.unref();
    });
    ttlTimer = setTimeout(() => finish({ code: null, reason: 'ttl' }), remaining); ttlTimer.unref();
  } catch { clearTimeout(handshake); finish({ code: null, reason: 'spawn_failed' }); }
});
