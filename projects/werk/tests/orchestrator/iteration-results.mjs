import assert from 'node:assert/strict';

/** @param {Awaited<ReturnType<typeof import('../../src/orchestrator/dist/orchestrator/intake/importer.js').importIteration>>} result */
export function expectPreview(result) {
  assert.ok(result.mode === 'preview', 'Expected a side-effect-free iteration preview.');
  return result;
}

/** @param {Awaited<ReturnType<typeof import('../../src/orchestrator/dist/orchestrator/intake/importer.js').importIteration>>} result */
export function expectImported(result) {
  assert.ok(result.mode === 'import', 'Expected an iteration import receipt.');
  return result;
}
