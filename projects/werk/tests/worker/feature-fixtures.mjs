import assert from 'node:assert/strict';
import { parseFeature } from '../../src/worker/dist/worker/infrastructure/features/document.js';

/** Inspect metadata emitted by the real worker writer, while ordinary parser input remains unknown.
 * @param {string} raw
 * @returns {Omit<ReturnType<typeof parseFeature>, 'data'> & {data: Record<string, unknown> & {werk?: Partial<import('../../src/worker/application/feature-requests.js').FeatureRecord> & {inputChanged?: boolean}}}}
 */
export function parseTrackedFeature(raw) {
  const parsed = parseFeature(raw), werk = parsed.data.werk;
  assert.ok(werk === undefined || (werk && typeof werk === 'object' && !Array.isArray(werk)));
  return { ...parsed, data: { ...parsed.data, werk } };
}

/** @param {Partial<import('../../src/worker/application/feature-requests.js').FeatureRecord>} [overrides]
 * @returns {import('../../src/worker/application/feature-requests.js').FeatureRecord} */
export function featureRecord(overrides = {}) {
  return { id: 'request', name: 'request.md', source: 'folder', taskId: 'feature-request', sessionId: 'feature-request',
    inputHash: 'a'.repeat(64), submitted: false, status: 'queued', createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z', ...overrides };
}
