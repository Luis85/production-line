import test from 'node:test';
import assert from 'node:assert/strict';
import { frontend } from '../helpers/frontend-loader.mjs';
const { taskActivityChanges } = await frontend('src/worker/webview/task-notifications.ts');
/** @returns {import('../../../src/worker/webview/task-overview').TaskOverviewItem} */
function item() { return { id: 'feature:one', taskId: 'FR-1', requestId: 'request-one', title: 'Deliver the feature', summary: '', source: 'project', sourceLabel: 'Project request', status: 'running', statusLabel: 'In progress', group: 'running', provider: 'claude-cli', model: null, modelBasis: 'unavailable', modelSnapshot: null, createdAt: null, updatedAt: '2026-10-25T10:00:00Z', archived: false, remote: false, primaryAction: { kind: 'review', label: 'Review', href: '/review?requestId=request-one' }, evidenceHref: '/review?requestId=request-one', deliveryPhaseLabel: 'Production' }; }
test('worker updates announce durable phase or attention changes and link to request evidence', () => {
  const previous = item(), current = { ...previous, deliveryPhaseLabel: 'Post-production' };
  assert.equal(taskActivityChanges([previous], [current])[0].message, 'Post-production · In progress');
  const review = { ...current, status: 'review', statusLabel: 'Review required', group: /** @type {const} */ ('attention') };
  assert.equal(taskActivityChanges([current], [review])[0].href, review.evidenceHref);
  assert.equal(taskActivityChanges([], [review])[0].taskId, 'FR-1');
});
test('timestamps, provider output and identical polling snapshots do not produce worker notifications', () => {
  const previous = item();
  assert.deepEqual(taskActivityChanges([previous], [{ ...previous, updatedAt: '2026-10-25T10:01:00Z', summary: 'A model claims completion.' }]), []);
  assert.deepEqual(taskActivityChanges([previous], []), []);
  assert.deepEqual(taskActivityChanges([], [{ ...previous, requestId: undefined, deliveryRunId: undefined }]), []);
});
