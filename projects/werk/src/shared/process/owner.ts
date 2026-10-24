import { execFile } from 'node:child_process';
import { constants, readlinkSync } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';

export type ProcessOwnerState = 'dead' | 'alive' | 'unknown';
export type OwnerCheck = (pid: number, since: Date | number) => Promise<ProcessOwnerState>;
// Linux boot time and macOS lstart have whole-second precision: only a clearly later start proves PID reuse.
const CLOCK_TOLERANCE_MS = 2000;
const LOCK_LIMIT = 65536;
/**
 * Where a recorded PID is meaningful: this host and, on Linux, its PID namespace. Native and Docker workers share
 * project state, so a PID recorded in a container or on another machine never proves anything here.
 */
export const processHost = hostname() + (process.platform === 'linux' ? ' ' + (() => { try { return readlinkSync('/proc/self/ns/pid'); } catch { return ''; } })() : '');

const output = (file: string, args: string[], env?: NodeJS.ProcessEnv) => new Promise<string>((resolve, reject) => {
  execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 10000, ...(env ? { env } : {}) }, (error, stdout) => error ? reject(error) : resolve(stdout));
});
/** Process start in epoch milliseconds; undefined when the platform does not disclose it. */
async function processStartTime(pid: number): Promise<number | undefined> {
  try {
    if (process.platform === 'linux') {
      // Field 22 (starttime, in USER_HZ=100 ticks since boot) counts from field 3, after the parenthesized command name.
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8'), boot = /^btime (\d+)$/m.exec(await readFile('/proc/stat', 'utf8'));
      const ticks = Number(stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]);
      return boot && Number.isFinite(ticks) ? (Number(boot[1]) + ticks / 100) * 1000 : undefined;
    }
    const text = process.platform === 'win32'
      ? await output('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`])
      : await output('ps', ['-o', 'lstart=', '-p', String(pid)], { ...process.env, LC_ALL: 'C' });
    const time = Date.parse(text.trim());
    return Number.isFinite(time) ? time : undefined;
  } catch { return undefined; }
}
/** 'dead' only with proof: no such process, or a process that started after `since` (a reused PID). */
export async function processOwnerState(pid: number, since: Date | number, startTime: (pid: number) => Promise<number | undefined> = processStartTime): Promise<ProcessOwnerState> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  try { process.kill(pid, 0); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code !== 'EPERM') return 'unknown';
  }
  const started = await startTime(pid), recorded = Number(since);
  return started !== undefined && Number.isFinite(recorded) && started > recorded + CLOCK_TOLERANCE_MS ? 'dead' : 'alive';
}
/** The PID, host and write time (startedAt, else mtime) a JSON lock or record names. Unreadable or partial content names no PID. */
export async function lockOwner(path: string): Promise<{ pid: number | null; host: string | null; since: number }> {
  try {
    if (!(await lstat(path)).isFile()) return { pid: null, host: null, since: Number.NaN };
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await file.stat(), buffer = Buffer.alloc(LOCK_LIMIT + 1), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const value = info.isFile() && bytesRead <= LOCK_LIMIT ? JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) : null;
      const started = Date.parse(value?.startedAt);
      return { pid: Number.isSafeInteger(value?.pid) && value.pid > 0 ? value.pid : null, host: typeof value?.host === 'string' ? value.host : null, since: Number.isFinite(started) ? started : info.mtimeMs };
    } finally { await file.close(); }
  } catch { return { pid: null, host: null, since: Number.NaN }; }
}
/** The command an operator runs to confirm a recorded owner has exited. */
export const ownerCheck = (pid: number, host: string | null) => host !== null && host !== processHost
  ? `PID ${pid} was recorded on ${host}, not this host: confirm it is not running there (for a container: docker compose ps).`
  : `Confirm PID ${pid} is not running (Windows: Get-Process -Id ${pid}; POSIX: ps -p ${pid}).`;
