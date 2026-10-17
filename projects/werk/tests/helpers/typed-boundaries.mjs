import assert from 'node:assert/strict';

/** @param {unknown} value @param {string} key @returns {unknown} */
export function testErrorField(value, key) {
  assert.ok(value !== null && typeof value === 'object', 'Expected an error object.');
  return /** @type {Record<string, unknown>} */ (value)[key];
}

/** @param {unknown} value */
export function testErrorCode(value) { return testErrorField(value, 'code'); }

/** @param {unknown} value */
export function testErrorMessage(value) {
  assert.ok(value !== null && typeof value === 'object' && 'message' in value && typeof value.message === 'string', 'Expected an error with a string message.');
  return value.message;
}

/** @param {import('node:net').Server} server */
export function testListeningAddress(server) {
  const address = server.address();
  assert.ok(address && typeof address !== 'string', 'Expected a listening TCP server.');
  return address;
}
