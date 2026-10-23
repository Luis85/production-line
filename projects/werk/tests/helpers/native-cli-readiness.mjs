import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);

/** Observe the real copied worker's cold startup; do not warm or replace its runtime.
 * @param {string} entry @param {string} cwd @param {AbortSignal} signal
 */
export async function waitForInstalledNativeWork(entry, cwd, signal) {
  // Keep each CLI's 40 s deadline and the caller's scenario deadline unchanged.
  // Native initialization has 45 s; this separate milestone allows 5 s for observation/cleanup.
  const timeout = AbortSignal.timeout(50000), pending = AbortSignal.any([signal, timeout]);
  let state = 'unobserved';
  try {
    for (;;) {
      pending.throwIfAborted();
      const { stdout } = await execute(process.execPath, [entry, 'repository', 'status'], { cwd, timeout: 40000, maxBuffer: 1048576, signal: pending });
      const status = JSON.parse(stdout);
      state = status.nativeWork?.state;
      assert.ok(['preparing', 'starting', 'ready'].includes(state), 'Repository status must expose native startup readiness.');
      if (state === 'ready') return status;
      await delay(100, undefined, { signal: pending });
    }
  } catch (error) {
    if (timeout.aborted && !signal.aborted) throw new Error(`Installed worker native startup did not become ready (last state: ${state}).`, { cause: error });
    throw error;
  }
}
