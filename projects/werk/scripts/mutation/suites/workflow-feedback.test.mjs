import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { reserveSharedReviewRework, advanceSharedReviewRework, validateSharedReviewReworks } from '../../../.mutation-build/worker/application/shared-review-rework.js';
import { reviewRequest, feedbackCommand } from './workflow-fixture.mjs';
const hash = text => createHash('sha256').update(text).digest('hex');
const fingerprint = value => hash(JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))));
/** @returns {import('../../../src/worker/application/shared-feature-state.ts').SharedFeatureRecord} */
function record() { return /** @type {import('../../../src/worker/application/shared-feature-state.ts').SharedFeatureRecord} */ (/** @type {unknown} */ ({ id: 'feature-one', taskId: 'task-one', claimed: true, submitted: true, status: 'ready_for_review', sourcePath: 'features/one.md', remoteRevision: hash('Confirmed source'), error: null })); }
function fixture() {
  const value = record(), request = reviewRequest(), command = feedbackCommand(), calls = [];
  /** @type {import('../../../src/worker/application/shared-feature-state.ts').SharedIntakePorts} */
  const ports = /** @type {import('../../../src/worker/application/shared-feature-state.ts').SharedIntakePorts} */ (/** @type {unknown} */ ({
    inspect() { return { status: 'review', summary: null, patch: null, request }; }, async reviewRework(_record, forwarded) { calls.push('dispatch'); assert.deepEqual(forwarded, command); forwarded.note = 'Adapter-local copy'; },
  }));
  /** @type {import('../../../src/worker/application/shared-feature-state.ts').SharedRepositoryPort} */
  const repository = /** @type {import('../../../src/worker/application/shared-feature-state.ts').SharedRepositoryPort} */ (/** @type {unknown} */ ({ async head() { return '1'.repeat(40); }, async readBlob(_commit, path) { assert.equal(path, value.sourcePath); return 'Confirmed source'; } }));
  const input = { record: value, ports, repository, signal: new AbortController().signal, async save() { calls.push('save:' + value.reviewReworks[0].status); }, async publish() { calls.push('publish'); } };
  return { value, request, command, calls, ports, repository, input };
}

test('shared feedback reserves immutable candidate identity and rejects cross-command reuse or unsafe owners', () => {
  const h = fixture(); reserveSharedReviewRework(h.value, h.command, h.ports);
  assert.deepEqual(h.value.reviewReworks, [{ command: h.command, digest: fingerprint(h.command), status: 'pending_source' }]); assert.notEqual(h.value.reviewReworks[0].command, h.command);
  assert.equal(h.value.status, 'needs_rework'); assert.equal(h.value.error, null); assert.match(h.value.progress, /confirm.*shared branch/);
  reserveSharedReviewRework(h.value, h.command, h.ports); assert.equal(h.value.reviewReworks.length, 1);
  assert.throws(() => reserveSharedReviewRework(h.value, { ...h.command, note: 'Changed reuse' }, h.ports), { code: 'conflict' });
  for (const change of [{ action: /** @type {const} */ ('execute') }, { note: '' }, { note: ' '.repeat(2) }, { note: 'x'.repeat(4001) }]) assert.throws(() => reserveSharedReviewRework(record(), { ...h.command, ...change }, h.ports), { code: 'invalid_input' });
  for (const mutate of [value => { value.claimed = false; }, value => { value.submitted = false; }, value => { value.task = { closed: false }; }, value => { value.reviewReworks = [{ command: h.command, digest: fingerprint(h.command), status: 'pending_dispatch' }]; }]) {
    const value = record(); mutate(value); assert.throws(() => reserveSharedReviewRework(value, { ...h.command, operationId: 'new-feedback' }, h.ports), { code: 'conflict' });
  }
  for (const mutate of [value => { value.request.id = 'other'; }, value => { value.request.deliveryHolds = []; }, value => { value.ports.inspect = () => undefined; }]) { const next = fixture(); mutate(next); assert.throws(() => reserveSharedReviewRework(next.value, next.command, next.ports), { code: 'conflict' }); }
  const maximum = fixture(); maximum.value.reviewReworks = Array.from({ length: 16 }, (_, index) => ({ command: { ...maximum.command, operationId: 'old-' + index }, digest: 'a'.repeat(64), status: 'dispatched' }));
  assert.throws(() => reserveSharedReviewRework(maximum.value, maximum.command, maximum.ports), /bounded review history/);
});

test('confirmed shared source and persisted stage precede dispatch; recovered dispatch stages never republish feedback', async () => {
  const h = fixture(); reserveSharedReviewRework(h.value, h.command, h.ports);
  Object.assign(h.value, { done: { passed: true, issues: [] }, featureBranch: 'old', featureCommit: 'old', outputDigest: 'old', reviewNote: 'old', reviewMarkdown: 'old', publishedReview: 'old', taskNote: 'old', task: {}, diagnostic: {} });
  assert.equal(await advanceSharedReviewRework(h.input), true);
  assert.deepEqual(h.calls, ['publish', 'save:pending_dispatch', 'dispatch', 'save:dispatched']);
  assert.equal(h.value.reviewReworks[0].command.note, h.command.note); assert.equal(h.value.reviewReworks[0].status, 'dispatched'); assert.equal(h.value.status, 'queued'); assert.equal(h.value.done, null);
  assert.equal(h.value.featureBranch, null); assert.equal(h.value.reviewNote, null); assert.equal(h.value.taskNote, null); assert.equal(h.value.error, null);
  for (const field of ['featureCommit', 'outputDigest', 'reviewMarkdown', 'publishedReview', 'task', 'diagnostic']) assert.equal(Object.hasOwn(h.value, field), false);
  assert.match(h.value.progress, /same Feature Request/);
  await advanceSharedReviewRework(h.input); assert.equal(h.calls.length, 4);
  const resumed = fixture(); reserveSharedReviewRework(resumed.value, resumed.command, resumed.ports); resumed.value.reviewReworks[0].status = 'pending_dispatch';
  await advanceSharedReviewRework(resumed.input); assert.deepEqual(resumed.calls, ['dispatch', 'save:dispatched']);
  const empty = fixture(); assert.equal(await advanceSharedReviewRework(empty.input), true); assert.deepEqual(empty.calls, []);
});

test('unknown source, pending outbox, missing dispatcher and lost acknowledgements cannot become successful rework', async () => {
  for (const source of [null, 'Changed source']) { const h = fixture(); reserveSharedReviewRework(h.value, h.command, h.ports); h.repository.readBlob = async () => source;
    await assert.rejects(advanceSharedReviewRework(h.input), { code: 'conflict' }); assert.deepEqual(h.calls, ['publish', 'save:pending_dispatch']); assert.equal(h.value.reviewReworks[0].status, 'pending_dispatch'); }
  const pending = fixture(); reserveSharedReviewRework(pending.value, pending.command, pending.ports); pending.value.pending = { operationId: 'prior-publication', request: { path: pending.value.sourcePath, expectedRevision: pending.value.remoteRevision, content: 'Confirmed source' }, artifacts: [] };
  await assert.rejects(advanceSharedReviewRework(pending.input), { code: 'conflict' }); assert.equal(pending.calls.includes('dispatch'), false);
  const missing = fixture(); reserveSharedReviewRework(missing.value, missing.command, missing.ports); delete missing.ports.reviewRework;
  await assert.rejects(advanceSharedReviewRework(missing.input), { code: 'unavailable' }); assert.deepEqual(missing.calls, []);
  const lost = fixture(); reserveSharedReviewRework(lost.value, lost.command, lost.ports); lost.input.publish = async () => { throw Error('Unknown source acknowledgement'); };
  await assert.rejects(advanceSharedReviewRework(lost.input), /Unknown source/); assert.equal(lost.value.reviewReworks[0].status, 'pending_source'); assert.deepEqual(lost.calls, []);
  const failed = fixture(); reserveSharedReviewRework(failed.value, failed.command, failed.ports); failed.ports.reviewRework = async () => { throw Error('Dispatch acknowledgement lost'); };
  await assert.rejects(advanceSharedReviewRework(failed.input), /Dispatch acknowledgement/); assert.equal(failed.value.reviewReworks[0].status, 'pending_dispatch');
});

test('persisted shared feedback validation rejects tampering and enforces real history bounds', () => {
  validateSharedReviewReworks(record()); const h = fixture(); reserveSharedReviewRework(h.value, h.command, h.ports); validateSharedReviewReworks(h.value);
  for (const mutate of [value => { value.reviewReworks = null; }, value => { value.reviewReworks.push(value.reviewReworks[0]); }, value => { value.reviewReworks[0].status = 'invented'; }, value => { value.reviewReworks[0].digest = 'f'.repeat(64); },
    value => { value.reviewReworks[0].command = { ...value.reviewReworks[0].command, candidateDigest: 'bad' }; },
  ]) { const changed = structuredClone(h.value); mutate(changed); assert.throws(() => validateSharedReviewReworks(changed)); }
  for (const change of [{ action: /** @type {const} */ ('execute') }, { operationId: '' }, { inputRevision: 0 }, { inputRevision: 1.5 }, { candidateCommit: '' }, { candidateDigest: '' }, { note: '' }, { note: 'x'.repeat(4001) }]) {
    const changed = structuredClone(h.value), command = { ...h.command, ...change }; changed.reviewReworks[0] = { command, digest: fingerprint(command), status: 'pending_source' }; assert.throws(() => validateSharedReviewReworks(changed));
  }
  const unresolved = structuredClone(h.value), second = { ...h.command, operationId: 'second-feedback' }; unresolved.reviewReworks.push({ command: second, digest: fingerprint(second), status: 'pending_dispatch' }); assert.throws(() => validateSharedReviewReworks(unresolved));
  const full = record(); full.reviewReworks = Array.from({ length: 16 }, (_, index) => { const command = { ...h.command, operationId: 'history-' + index }; return { command, digest: fingerprint(command), status: 'dispatched' }; });
  validateSharedReviewReworks(full); const extra = { ...h.command, operationId: 'history-extra' }; full.reviewReworks.push({ command: extra, digest: fingerprint(extra), status: 'dispatched' }); assert.throws(() => validateSharedReviewReworks(full));
});
