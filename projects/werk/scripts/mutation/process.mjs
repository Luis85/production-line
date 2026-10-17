import { spawn, spawnSync } from 'node:child_process';

/**
 * Own a tool process tree through timeout/cancellation, including an early-exiting leader.
 * @param {{command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs: number, graceMs?: number, signal?: AbortSignal, onData?: (chunk: string | Buffer) => void}} options
 */
export async function runOwnedProcess({ command, args, cwd, env, timeoutMs, graceMs = 1500, signal, onData = () => {} }) {
  if (signal?.aborted) return { exitCode: null, timedOut: false, error: 'Mutation analysis was cancelled.' };
  const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let timedOut = false, cancelled = false, timer, stopping;
  function killTree(signalName) {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') {
        const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
        if (result.error) onData(`Process cleanup: ${result.error.message}\n`);
      } else process.kill(-child.pid, signalName);
    } catch (error) { if (error.code !== 'ESRCH') onData(`Process cleanup: ${error.message}\n`); }
  }
  function stop() {
    if (stopping) return;
    killTree('SIGTERM');
    // Do not cancel escalation when the leader exits: descendants share its process group.
    stopping = new Promise(resolve => setTimeout(() => { killTree('SIGKILL'); resolve(); }, graceMs));
  }
  const onAbort = () => { cancelled = true; stop(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({ exitCode: null, error: `Unable to start Stryker: ${error.message}` }));
    child.once('close', (exitCode, signalName) => resolve({ exitCode, signal: signalName }));
    timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  });
  clearTimeout(timer);
  if (stopping) await stopping;
  else killTree('SIGKILL'); // Reap any detached descendants left by a completed or crashed leader.
  signal?.removeEventListener('abort', onAbort);
  return { ...result, timedOut, ...(cancelled ? { error: 'Mutation analysis was cancelled.' } : {}) };
}
