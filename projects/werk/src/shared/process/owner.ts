import { execFile } from 'node:child_process';
import { constants, readFileSync, readlinkSync } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';

export type ProcessOwnerState = 'dead' | 'alive' | 'unknown';
/** Linux: `linux:<boot_id>:<starttime ticks>`, compared exactly. Elsewhere: creation time in epoch milliseconds. */
export type ProcessStart = string | number;
export type OwnerCheck = (pid: number, start: ProcessStart | null) => Promise<ProcessOwnerState>;
// Clocks may step between process creation and the recorded start; only a larger difference proves PID reuse.
const START_TOLERANCE_MS = 10000;
const LOCK_LIMIT = 65536;
/**
 * Where a recorded PID is meaningful: this host and, on Linux, its PID namespace. Native and Docker workers share
 * project state, so a PID recorded in a container or on another machine never proves anything here.
 */
export const processHost = hostname() + (process.platform === 'linux' ? ' ' + (() => { try { return readlinkSync('/proc/self/ns/pid'); } catch { return ''; } })() : '');

// Field 22 (starttime ticks since boot) counts from field 3, after the parenthesized command name.
const linuxStart = (stat: string, boot: string) => { const ticks = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]; return /^\d+$/.test(ticks ?? '') && boot ? `linux:${boot}:${ticks}` : undefined; };
const bootId = (text: string) => text.trim();
function ownStart(): ProcessStart | null {
  if (process.platform !== 'linux') return Math.round(Date.now() - process.uptime() * 1000);
  try { return linuxStart(readFileSync('/proc/self/stat', 'utf8'), bootId(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'))) ?? null; } catch { return null; }
}
/** Spread into every lock or record whose owner may later be proven dead: PID, host and start identity. */
export const ownerRecord = { pid: process.pid, host: processHost, start: ownStart() };

const output = (file: string, args: string[], env?: NodeJS.ProcessEnv) => new Promise<string>((resolve, reject) => {
  execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 10000, ...(env ? { env } : {}) }, (error, stdout) => error ? reject(error) : resolve(stdout));
});
/** The current start identity of `pid`; undefined when the platform does not disclose it. */
async function processStart(pid: number): Promise<ProcessStart | undefined> {
  try {
    if (process.platform === 'linux') return linuxStart(await readFile(`/proc/${pid}/stat`, 'utf8'), bootId(await readFile('/proc/sys/kernel/random/boot_id', 'utf8')));
    // CIM reports creation time to unelevated callers; Get-Process StartTime does not for other users' processes.
    const text = process.platform === 'win32'
      ? await output('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString('o')`])
      : await output('ps', ['-o', 'lstart=', '-p', String(pid)], { ...process.env, LC_ALL: 'C' });
    const time = Date.parse(text.trim());
    return Number.isFinite(time) ? time : undefined;
  } catch { return undefined; }
}
/**
 * 'dead' only with proof: no such process, or a process whose start identity differs from the recorded one (a reused
 * PID). A record without an identity, or an unreadable identity, never proves more than a missing process.
 */
export async function processOwnerState(pid: number, start: ProcessStart | null, current: (pid: number) => Promise<ProcessStart | undefined> = processStart): Promise<ProcessOwnerState> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  try { process.kill(pid, 0); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code !== 'EPERM') return 'unknown';
  }
  if (start === null) return 'alive';
  const now = await current(pid);
  if (typeof now === 'string' && typeof start === 'string') return now !== start ? 'dead' : 'alive';
  if (typeof now === 'number' && typeof start === 'number') return Math.abs(now - start) > START_TOLERANCE_MS ? 'dead' : 'alive';
  return 'alive';
}
const recordedStart = (value: unknown): ProcessStart | null => typeof value === 'string' && /^linux:[^:]+:\d+$/.test(value) || typeof value === 'number' && Number.isFinite(value) ? value as ProcessStart : null;
/** The PID, host and start identity a JSON lock or record names. Unreadable or partial content names no PID. */
export async function lockOwner(path: string): Promise<{ pid: number | null; host: string | null; start: ProcessStart | null }> {
  try {
    if (!(await lstat(path)).isFile()) return { pid: null, host: null, start: null };
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await file.stat(), buffer = Buffer.alloc(LOCK_LIMIT + 1), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const value = info.isFile() && bytesRead <= LOCK_LIMIT ? JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) : null;
      return { pid: Number.isSafeInteger(value?.pid) && value.pid > 0 ? value.pid : null, host: typeof value?.host === 'string' ? value.host : null, start: recordedStart(value?.start) };
    } finally { await file.close(); }
  } catch { return { pid: null, host: null, start: null }; }
}
/** The command an operator runs to confirm a recorded owner has exited. */
export const ownerCheck = (pid: number, host: string | null) => host !== null && host !== processHost
  ? `PID ${pid} was recorded on ${host}, not on this host (${processHost}). If this machine was renamed or the worker runs in Docker (docker compose ps), verify that process has exited before removing the listed files.`
  : `Confirm PID ${pid} is not running (Windows: Get-Process -Id ${pid}; POSIX: ps -p ${pid}).`;
