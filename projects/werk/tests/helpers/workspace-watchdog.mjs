import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { processIsRunning, removeWorkspace, terminateProcessesUnder } from './workspace-processes.mjs';

// Fixture guard for ownWorkspace(). `launch` re-spawns the guard detached and exits, then the
// guard waits: it exits when the test removes the workspace, or cleans up after a test process
// that died before its after hooks ran.
const [mode, parentArgument, directory] = process.argv.slice(2), parent = Number(parentArgument);

if (mode === 'launch') {
  const guard = spawn(process.execPath, [fileURLToPath(import.meta.url), 'guard', parentArgument, directory], { cwd: tmpdir(), detached: true, stdio: 'ignore', windowsHide: true });
  guard.unref();
  process.stdout.write(String(guard.pid ?? ''));
} else if (mode === 'guard' && Number.isInteger(parent) && directory) {
  const deadline = Date.now() + 6 * 60 * 60 * 1000;
  while (existsSync(directory) && Date.now() < deadline) {
    if (!processIsRunning(parent)) {
      // Leave the workspace for inspection if process termination fails.
      await terminateProcessesUnder(directory, [process.pid]);
      await removeWorkspace(directory);
      break;
    }
    await delay(1000);
  }
}
