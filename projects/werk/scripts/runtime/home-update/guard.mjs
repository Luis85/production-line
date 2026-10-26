import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ordinary, readRegular } from './ownership.mjs';
/** Serializes Home startup through readiness and update/rollback through verification. */
export async function withHomeRuntimeLock(home, operation) {
  await ordinary(join(home, 'state'), true);
  const path = join(home, 'state/home-runtime.lock'), nonce = randomUUID();
  const handle = await open(path, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw Error('Another Home startup or update holds state/home-runtime.lock. After a crash, inspect its PID and retained update status before explicitly removing the abandoned lock.');
    throw error;
  });
  let value, failure;
  try {
    await handle.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce, at: new Date().toISOString() })); await handle.sync();
    value = await operation();
  } catch (error) { failure = error; }
  let cleanupFailure;
  try {
    await handle.close();
    const record = JSON.parse((await readRegular(path, 4096)).toString('utf8'));
    if (record.nonce !== nonce) throw Error('Home runtime reservation changed; preserve it for inspection.');
    await unlink(path);
  } catch (error) { cleanupFailure = error; }
  if (failure && cleanupFailure) throw new AggregateError([failure, cleanupFailure], 'Home operation failed and its reservation needs inspection.');
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
  return value;
}


/** Foreground components coexist; their retained leases still exclude payload replacement. */
export async function withHomeRuntimeLease(home, operation, { untilExit = false } = {}) {
  const nonce = randomUUID(), path = join(home, 'state/runtime-leases', nonce + '.json');
  await withHomeRuntimeLock(home, async () => {
    await ordinary(join(home, 'state/runtime-leases'), true);
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce, at: new Date().toISOString() })); await handle.sync(); } finally { await handle.close(); }
  });
  const cleanup = async () => {
    const record = JSON.parse((await readRegular(path, 4096)).toString('utf8'));
    if (record.nonce !== nonce || record.pid !== process.pid) throw Error('Foreground Home lease changed; preserve it for inspection.');
    await unlink(path);
  };
  if (untilExit) {
    // Component imports can finish at readiness while HTTP servers keep the process alive.
    // A graceful drain emits beforeExit; fatal exits preserve their lease for explicit inspection.
    process.once('beforeExit', () => { void cleanup().catch(() => { console.error('Home runtime lease cleanup failed. Inspect state/runtime-leases before updating.'); process.exitCode = 1; }); });
    return operation();
  }
  let value, failure;
  try { value = await operation(); } catch (error) { failure = error; }
  let cleanupFailure;
  try { await cleanup(); } catch (error) { cleanupFailure = error; }
  if (failure && cleanupFailure) throw new AggregateError([failure, cleanupFailure], 'Foreground component failed and its Home lease needs inspection.');
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
  return value;
}
