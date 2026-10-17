import assert from 'node:assert/strict';

/**
 * Assert that an asynchronous fixture produced the value the test is inspecting.
 * @template T
 * @param {T | null | undefined} value
 * @returns {T}
 */
export function requiredValue(value) {
  assert.ok(value !== null && value !== undefined, 'Expected a captured fixture value');
  return value;
}
