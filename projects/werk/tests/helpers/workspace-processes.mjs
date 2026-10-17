import { execFile, spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

// Portable `start` launches a detached `_run` worker that outlives the CLI call (and, on
// Windows, any `taskkill /T` of the test runner, because its launching parent has exited).
// Fixtures that start apps inside a temporary workspace own every process whose command
// line names that workspace: its copied cli.mjs path and the mkdtemp suffix are unique.
const execute = promisify(execFile);
const watchdog = fileURLToPath(new URL('./workspace-watchdog.mjs', import.meta.url));

const PROCESS_QUERY_TIMEOUT_MS = 30000;
const PROCESS_TERMINATION_TIMEOUT_MS = 10000;
const WORKSPACE_CLEANUP_TIMEOUT_MS = 60000;
const WATCHDOG_LAUNCH_TIMEOUT_MS = 30000;
const WATCHDOG_EXIT_TIMEOUT_MS = 10000;

/** A zombie has exited even when a container init has not reaped its PID yet. */
export function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); }
  catch (error) { if (error.code !== 'EPERM') return false; }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const stateIndex = stat.lastIndexOf(') ') + 2;
      const state = stat[stateIndex];
      if (state === 'Z' || state === 'X') return false;
    } catch (error) { if (error.code === 'ENOENT') return false; }
  }
  return true;
}

function needles(directory) {
  const paths = new Set([directory]);
  try { paths.add(realpathSync.native(directory)); } catch {}
  return [...paths];
}

/** PIDs whose command line contains `directory`, excluding this process and `exclude`. */
export async function processesUnder(directory, exclude = [], timeoutMs = PROCESS_QUERY_TIMEOUT_MS) {
  const skip = new Set([process.pid, ...exclude]), search = needles(directory);
  const deadline = Date.now() + timeoutMs;
  let lines;
  if (process.platform === 'win32') {
    // The needles travel in the environment so the query never matches its own command line.
    const query = '$needles = $env:WERK_TEST_WORKSPACE.Split([char]124); Get-CimInstance Win32_Process | Where-Object { $line = $_.CommandLine; $line -and @($needles | Where-Object { $_ -and $line.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count } | ForEach-Object { $_.ProcessId }';
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { env: { ...process.env, WERK_TEST_WORKSPACE: search.join('|') }, windowsHide: true, timeout: timeoutMs });
    lines = stdout.split(/\r?\n/).map(line => ({ pid: Number(line.trim()) }));
  } else if (process.platform === 'linux') {
    lines = [];
    for (const name of await readdir('/proc')) {
      if (Date.now() >= deadline) throw Error(`Timed out inspecting processes for ${directory}`);
      if (!/^\d+$/.test(name)) continue;
      const command = await readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '');
      if (search.some(needle => command.replaceAll('\0', ' ').includes(needle))) lines.push({ pid: Number(name) });
    }
  } else {
    const { stdout } = await execute('ps', ['-A', '-ww', '-o', 'pid=', '-o', 'args='], { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs });
    lines = stdout.split('\n').map(line => /^\s*(\d+)\s(.*)$/.exec(line)).filter(Boolean).map(([, pid, command]) => ({ pid: Number(pid), command }))
      .filter(entry => search.some(needle => entry.command.includes(needle)));
  }
  return [...new Set(lines.map(entry => entry.pid))].filter(pid => Number.isInteger(pid) && pid > 0 && !skip.has(pid));
}

async function terminateTree(pid, timeoutMs) {
  if (process.platform === 'win32') {
    try { await execute('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: timeoutMs }); }
    catch (error) {
      // A disappearing PID is expected; timeout is a cleanup failure, not success.
      if (error.killed || error.code === 'ETIMEDOUT') throw Error(`Timed out terminating workspace process tree ${pid}`);
    }
    return;
  }
  // Detached POSIX workers lead their own process group, which includes their providers.
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

/** Terminates every process tree still running from `directory` and waits until none remain. */
export async function terminateProcessesUnder(directory, exclude = []) {
  const terminated = new Set(), deadline = Date.now() + WORKSPACE_CLEANUP_TIMEOUT_MS;
  let remaining = [];
  for (let round = 0; round < 20 && Date.now() < deadline; round++) {
    remaining = await processesUnder(directory, exclude, Math.max(1, Math.min(PROCESS_QUERY_TIMEOUT_MS, deadline - Date.now())));
    if (!remaining.length) return [...terminated];
    for (const pid of remaining) {
      if (Date.now() >= deadline) break;
      terminated.add(pid);
      await terminateTree(pid, Math.max(1, Math.min(PROCESS_TERMINATION_TIMEOUT_MS, deadline - Date.now())));
    }
    await delay(Math.max(0, Math.min(250, deadline - Date.now())));
  }
  if (Date.now() < deadline) {
    remaining = await processesUnder(directory, exclude, Math.max(1, Math.min(PROCESS_QUERY_TIMEOUT_MS, deadline - Date.now())));
    if (!remaining.length) return [...terminated];
  }
  throw Error(`Workspace process cleanup did not finish within its retry/time budget for ${directory}: ${remaining.join(', ')}`);
}

/** Retries Windows EBUSY/EPERM while released handles of terminated processes close. */
export const removeWorkspace = directory => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });

function startWatchdog(directory) {
  // The launcher exits at once, so the guard survives a runner tree kill.
  // A failed or stuck launcher must fail the fixture rather than silently losing ownership.
  const launcher = spawn(process.execPath, [watchdog, 'launch', String(process.pid), directory], {
    cwd: tmpdir(), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    timeout: WATCHDOG_LAUNCH_TIMEOUT_MS, killSignal: 'SIGKILL',
  });
  return new Promise((resolve, reject) => {
    let output = '';
    launcher.stdout.on('data', part => output += part);
    launcher.once('error', error => reject(Error('Could not start workspace cleanup guard', { cause: error })));
    launcher.once('close', (code, signal) => {
      if (launcher.killed) { reject(Error('Workspace cleanup guard launch timed out')); return; }
      const pid = Number(output.trim());
      if (code !== 0 || signal || !Number.isInteger(pid) || pid <= 0) {
        reject(Error(`Could not start workspace cleanup guard (exit ${code}, signal ${signal ?? 'none'})`)); return;
      }
      resolve(pid);
    });
  });
}

/**
 * Owns a temporary workspace in which a test starts portable apps. After the test (pass, failure
 * or timeout) `stop` asks the apps to shut down through their own CLI; any process whose command
 * line still names the workspace is then terminated with its tree, cleanup waits until none
 * remain and only then removes the directory. If the test process dies before after hooks run
 * (Ctrl+C, a killed runner), a detached guard performs the same termination and removal.
 */
export async function ownWorkspace(t, directory, stop = async () => {}) {
  let guard;
  // Own cleanup before launching: a failed launcher may already have spawned its guard.
  t.after(async () => {
    try { await stop(); } catch {}
    const terminated = await terminateProcessesUnder(directory, guard ? [guard] : []);
    if (terminated.length) t.diagnostic(`terminated ${terminated.length} process tree(s) left running in ${directory}`);
    await removeWorkspace(directory);
    // The guard polls for removal once a second. Teardown owns its exit as well as the
    // workers, so callers cannot observe a surviving guard after their after hook finishes.
    const deadline = Date.now() + WATCHDOG_EXIT_TIMEOUT_MS;
    while (guard && processIsRunning(guard)) {
      if (Date.now() >= deadline) throw Error(`Workspace cleanup guard ${guard} did not exit after removal of ${directory}`);
      await delay(Math.min(100, deadline - Date.now()));
    }
  });
  guard = await startWatchdog(directory);
}
