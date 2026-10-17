import assert from 'node:assert/strict';

/** @param {unknown} value @param {'stdout' | 'stderr'} stream */
export function testErrorOutput(value, stream) {
  assert.ok(value !== null && typeof value === 'object' && stream in value, 'Expected captured process output.');
  const output = value[stream];
  assert.ok(typeof output === 'string' || Buffer.isBuffer(output), 'Expected text or bytes from the process.');
  return output.toString();
}

/** @param {unknown} value @param {'status' | 'exitCode'} field */
export function testErrorStatus(value, field) {
  assert.ok(value !== null && typeof value === 'object' && field in value, 'Expected a process or command exit status.');
  const status = value[field];
  assert.equal(typeof status, 'number');
  return status;
}
