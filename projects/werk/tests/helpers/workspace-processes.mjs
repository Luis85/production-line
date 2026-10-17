import { execFile, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
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

function needles(directory) {
  const paths = new Set([directory]);
  try { paths.add(realpathSync.native(directory)); } catch {}
  return [...paths];
}

/** PIDs whose command line contains `directory`, excluding this process and `exclude`. */
export async function processesUnder(directory, exclude = []) {
  const skip = new Set([process.pid, ...exclude]), search = needles(directory);
  let lines;
  if (process.platform === 'win32') {
    // The needles travel in the environment so the query never matches its own command line.
    const query = '$needles = $env:WERK_TEST_WORKSPACE.Split([char]124); Get-CimInstance Win32_Process | Where-Object { $line = $_.CommandLine; $line -and @($needles | Where-Object { $_ -and $line.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count } | ForEach-Object { $_.ProcessId }';
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { env: { ...process.env, WERK_TEST_WORKSPACE: search.join('|') }, windowsHide: true, timeout: 60000 });
    lines = stdout.split(/\r?\n/).map(line => ({ pid: Number(line.trim()) }));
  } else if (process.platform === 'linux') {
    lines = [];
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const command = await readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '');
      if (search.some(needle => command.replaceAll('\0', ' ').includes(needle))) lines.push({ pid: Number(name) });
    }
  } else {
    const { stdout } = await execute('ps', ['-A', '-o', 'pid=', '-o', 'args='], { maxBuffer: 16 * 1024 * 1024, timeout: 60000 });
    lines = stdout.split('\n').map(line => /^\s*(\d+)\s(.*)$/.exec(line)).filter(Boolean).map(([, pid, command]) => ({ pid: Number(pid), command }))
      .filter(entry => search.some(needle => entry.command.includes(needle)));
  }
  return [...new Set(lines.map(entry => entry.pid))].filter(pid => Number.isInteger(pid) && pid > 0 && !skip.has(pid));
}

async function terminateTree(pid) {
  if (process.platform === 'win32') { await execute('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }).catch(() => {}); return; }
  // Detached POSIX workers lead their own process group, which includes their providers.
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

/** Terminates every process tree still running from `directory` and waits until none remain. */
export async function terminateProcessesUnder(directory, exclude = []) {
  const terminated = new Set();
  for (let round = 0; round < 20; round++) {
    const found = await processesUnder(directory, exclude);
    if (!found.length) return [...terminated];
    for (const pid of found) { terminated.add(pid); await terminateTree(pid); }
    await delay(250);
  }
  throw Error(`Processes started from ${directory} survived cleanup: ${(await processesUnder(directory, exclude)).join(', ')}`);
}

/** Retries Windows EBUSY/EPERM while released handles of terminated processes close. */
export const removeWorkspace = directory => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });

function startWatchdog(directory) {
  // The launcher exits at once, so the guard is not a descendant of this test process and
  // survives a runner tree kill. It reports the guard PID so normal teardown skips it.
  const launcher = spawn(process.execPath, [watchdog, 'launch', String(process.pid), directory], { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  return new Promise(resolve => {
    let output = '';
    launcher.stdout.on('data', part => output += part);
    launcher.once('error', () => resolve(null));
    launcher.once('close', () => resolve(Number(output.trim()) || null));
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
  const guard = await startWatchdog(directory);
  t.after(async () => {
    try { await stop(); } catch {}
    const terminated = await terminateProcessesUnder(directory, guard ? [guard] : []);
    if (terminated.length) t.diagnostic(`terminated ${terminated.length} process tree(s) left running in ${directory}`);
    await removeWorkspace(directory);
  });
}
