import { launchProcess, terminateProcess } from '../../src/worker/dist/shared/process/launcher.js';

/** @template T @param {Promise<T>} operation @param {string} label @param {number} milliseconds @param {AbortSignal} [signal] @returns {Promise<T>} */
export async function boundedServiceWait(operation, label, milliseconds, signal) {
  let timer, cancelled;
  /** @type {Promise<never>} */
  const deadline = new Promise((_, reject) => {
    cancelled = () => reject(signal.reason ?? Error(`${label} was cancelled.`));
    timer = setTimeout(() => reject(Error(`${label} did not settle within ${milliseconds} ms.`)), milliseconds);
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
  });
  try { return await Promise.race([operation, deadline]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancelled); }
}

/** Test ownership is captured at spawn, never discovered later from process IDs. @param {AbortSignal} signal */
export function createServiceProcessLifetime(signal, cleanupMs = 2000) {
  /** @type {Map<import('node:child_process').ChildProcess, { closed: Promise<void>, confirmed: boolean, terminate(): void }>} */
  const children = new Map();
  const force = () => {
    for (const [child, entry] of children) if (!entry.confirmed && child.exitCode === null && child.signalCode === null) {
      try { entry.terminate(); } catch { /* The bounded drain reports unconfirmed cleanup. */ }
    }
  };
  signal.addEventListener('abort', force, { once: true });
  /** @template {import('node:child_process').ChildProcess} T @param {T} child @param {(child: T) => void} [terminate] @returns {T} */
  const own = (child, terminate = value => { value.kill('SIGKILL'); }) => {
    if (children.has(child)) throw Error('A fixture child was registered twice.');
    let confirm;
    /** @type {Promise<void>} */
    const closed = new Promise(resolve => { confirm = () => resolve(undefined); });
    const entry = { closed, confirmed: false, terminate: () => terminate(child) };
    children.set(child, entry);
    child.once('close', () => { entry.confirmed = true; confirm(); });
    // An abort can occur before a slow setup returns its next owned child.
    if (signal.aborted) force();
    return child;
  };
  return {
    own,
    /** @type {typeof launchProcess} */
    launch(executable, args, options) { return own(launchProcess(executable, args, options), terminateProcess); },
    /** @template T @param {Promise<T>} operation @param {string} label @returns {Promise<T>} */
    wait(operation, label, milliseconds = 20000) { return boundedServiceWait(operation, label, milliseconds, signal); },
    closed(child) {
      const entry = children.get(child);
      if (!entry) throw Error('Only an owned fixture child may be awaited.');
      return boundedServiceWait(entry.closed, 'Owned fixture child close', 20000, signal);
    },
    async close() {
      signal.removeEventListener('abort', force);
      force();
      try { await boundedServiceWait(Promise.all([...children.values()].map(entry => entry.closed)), 'Owned fixture cleanup', cleanupMs); }
      finally {
        // A failed drain remains a failure. Releasing our pipes cannot fabricate a close receipt.
        for (const child of children.keys()) { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); }
        children.clear();
      }
    },
  };
}
