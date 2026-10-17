import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedFeatureLifecycle } from '../../src/worker/dist/worker/application/shared-feature-lifecycle.js';
import { SharedFeatureFeedback } from '../../src/worker/dist/worker/application/shared-feature-feedback.js';
import { sharedHash } from '../../src/worker/dist/worker/application/shared-feature-notes.js';
import { DomainError } from '../../src/worker/dist/shared/errors.js';
import { readTaskNote, renderTaskNote } from '../../src/worker/dist/worker/application/task-notes.js';
import { renderSharedSource } from '../../src/worker/dist/worker/infrastructure/features/shared-source.js';
import { acceptedSharedBody } from '../../src/worker/dist/worker/infrastructure/features/shared-progress.js';
import { parseFeature } from '../../src/worker/dist/worker/infrastructure/features/document.js';
import { trackingSharedRecord } from './tracking-fixtures.mjs';

/** @param {string} [suffix] @returns {import('../../src/worker/application/interactions.js').InteractionView} */
function waiting(suffix = '1') {
  const at = '2026-10-17T00:00:00.000Z';
  const turn = { id: 'turn-' + suffix, runId: null, kind: /** @type {const} */ ('message'), status: /** @type {const} */ ('waiting_input'), createdAt: at, finishedAt: at, priorTurnId: null };
  return { schemaVersion: 1, sessionId: 'session-one', revision: Number(suffix), phase: 'waiting_input', pending: { id: 'question-' + suffix, kind: 'question', message: 'Which target?', createdAt: at, turnId: turn.id }, latestTurn: turn, turns: [turn], totalTurns: Number(suffix) };
}
async function fixture() {
  let record = trackingSharedRecord();
  /** @type {import('../../src/worker/application/shared-feature-state.js').SharedExecution} */
  let execution = { status: 'waiting_input', summary: null, patch: null, request: null, interaction: waiting() };
  /** @type {Map<string,string>} */
  const files = new Map([[record.sourcePath, record.sourceMarkdown]]);
  record.remoteRevision = sharedHash(record.sourceMarkdown);
  /** @type {Map<string,import('../../src/worker/application/interactions.js').InteractionCommand>} */
  const admissions = new Map();
  const controls = { unavailable: false, lostAck: false, conflict: false, saveFailure: false, nextFailure: false };
  let saves = 0;
  const unexpected = async () => { throw Error('Unexpected feedback boundary'); };
  /** @type {import('../../src/worker/application/shared-feature-state.js').SharedRepositoryPort} */
  const repository = { head: async () => 'a'.repeat(40), readBlob: async (_commit, path) => files.get(path) ?? null, listRequests: unexpected, async publishLifecycle(write) {
    for (const artifact of [write.request, ...write.artifacts]) assert.equal(files.has(artifact.path) ? sharedHash(files.get(artifact.path)) : null, artifact.expectedRevision);
    for (const artifact of [write.request, ...write.artifacts]) files.set(artifact.path, artifact.content);
    return { commit: 'a'.repeat(40), head: 'a'.repeat(40) };
  }, publishPatch: unexpected };
  /** @type {import('../../src/worker/application/shared-feature-state.js').SharedIntakePorts} */
  const ports = {
    load: unexpected, save: unexpected, repository: () => repository, loadWorkflow: unexpected,
    ready: () => { throw Error('Unexpected readiness'); }, source: () => { throw Error('Unexpected source'); }, renderSource: value => JSON.stringify({ status: value.status, task: value.taskNote, error: value.error }), submit: unexpected, inspect: () => execution, canAdmit: () => true,
    async continue(_record, command) {
      if (admissions.has(command.operationId)) return;
      if (controls.unavailable) throw new DomainError('unavailable', 'Daily allowance is exhausted. Retry after reset.');
      if (controls.conflict) throw new DomainError('conflict', 'This interaction revision is stale.');
      admissions.set(command.operationId, structuredClone(command));
      if (controls.nextFailure) fail('3');
      if (controls.lostAck) throw Error('Lost admission acknowledgement');
    },
  };
  function fail(suffix) {
    const interaction = waiting(suffix); interaction.phase = 'failed'; interaction.pending = null; interaction.latestTurn.status = 'failed';
    execution = { ...execution, status: 'failed', error: 'same failure', interaction };
  }
  const save = async () => { if (controls.saveFailure) throw Error('Disk unavailable'); saves++; };
  let feedback = new SharedFeatureFeedback(ports, save);
  const sync = () => feedback.synchronize(record, repository, execution, new AbortController().signal);
  function publish(result) {
    for (const artifact of result.artifacts) {
      assert.equal(files.has(artifact.path) ? sharedHash(files.get(artifact.path)) : null, artifact.expectedRevision);
      files.set(artifact.path, artifact.content);
      if (record.task?.path === artifact.path) record.task.revision = sharedHash(artifact.content);
    }
  }
  function answer(text = 'Linux') {
    assert.ok(record.task);
    const content = renderTaskNote({ identity: record.task.identity, title: record.title, question: 'Which target?', answer: text, status: 'ready' });
    files.set(record.task.path, content); return content;
  }
  publish(await sync());
  return { get record() { return record; }, get execution() { return execution; }, files, admissions, controls, sync, publish, answer, get saves() { return saves; },
    restart() { record = structuredClone(record); feedback = new SharedFeatureFeedback(ports, save); },
    reconcile: () => new SharedFeatureLifecycle(ports, save).reconcile(record, new AbortController().signal), fail,
    nextQuestion() { execution = { ...execution, interaction: waiting('2') }; },
    async refresh() { await feedback.refreshAcknowledgement(record, repository, new AbortController().signal); },
  };
}

test('shared response reservations replay the same accepted operation after unknown acknowledgement and restart', async () => {
  const f = await fixture(); f.answer(); f.controls.lostAck = true;
  const first = await f.sync(); assert.match(first.error, /Lost admission/); assert.equal(f.record.task.response.status, 'pending');
  assert.equal(f.admissions.size, 1); assert.equal(readTaskNote(f.files.get(f.record.task.path), f.record.task.identity).status, 'ready');
  const operation = f.record.task.response.command.operationId;
  f.restart(); f.controls.lostAck = false; f.publish(await f.sync());
  assert.equal(f.record.task.response.command.operationId, operation); assert.equal(f.record.task.response.status, 'processed');
  assert.equal(readTaskNote(f.files.get(f.record.task.path), f.record.task.identity).status, 'processed');
  for (let i = 0; i < 3; i++) f.publish(await f.sync());
  assert.equal(f.admissions.size, 1); assert.ok(f.saves >= 3);
});

test('shared Task answers remain ready through allowance holds and identity tampering never dispatches', async () => {
  const f = await fixture(), content = f.answer();
  f.files.set(f.record.task.path, content.replace('owner: worker', 'owner: another-worker'));
  assert.match((await f.sync()).error, /identity changed/); assert.equal(f.admissions.size, 0);
  f.files.set(f.record.task.path, content); f.controls.unavailable = true;
  assert.match((await f.sync()).error, /allowance/); assert.equal(f.admissions.size, 0);
  assert.equal(f.files.get(f.record.task.path), content);
  f.restart(); f.controls.unavailable = false; f.publish(await f.sync());
  assert.equal(f.admissions.size, 1); assert.equal(readTaskNote(f.files.get(f.record.task.path), f.record.task.identity).answer, 'Linux');
});

test('an error acknowledgement does not prevent publishing the next real question', async () => {
  const f = await fixture(); f.answer(); f.controls.conflict = true;
  const rejected = await f.sync(); f.publish(rejected);
  const oldPath = f.record.task.path, oldMarkdown = f.files.get(oldPath);
  assert.equal(readTaskNote(oldMarkdown, f.record.task.identity).status, 'error');
  f.nextQuestion(); f.controls.conflict = false;
  f.publish(await f.sync());
  assert.notEqual(f.record.task.path, oldPath); assert.equal(f.files.get(oldPath), oldMarkdown);
  assert.equal(f.record.task.identity.pendingId, 'question-2'); assert.equal(f.admissions.size, 0);
});

test('a teammate edit during acknowledgement publication is retained without another dispatch', async () => {
  const f = await fixture(); f.answer('Linux');
  const accepted = await f.sync(); assert.equal(accepted.artifacts.length, 1);
  f.record.pending = { operationId: 'original-publication', request: { path: f.record.sourcePath, content: 'Frozen source', expectedRevision: f.record.remoteRevision }, artifacts: accepted.artifacts };
  const newer = f.answer('Windows');
  await f.refresh();
  const artifact = f.record.pending.artifacts[0];
  assert.equal(artifact.expectedRevision, sharedHash(newer)); assert.notEqual(f.record.pending.operationId, 'original-publication');
  const result = readTaskNote(artifact.content, f.record.task.identity);
  assert.equal(result.answer, 'Windows'); assert.equal(result.status, 'error'); assert.match(result.error, /previous answer was already accepted/);
  f.publish({ artifacts: [artifact] }); delete f.record.pending;
  f.publish(await f.sync()); assert.equal(f.admissions.size, 1);
  assert.equal([...f.admissions.values()][0].answer, 'Linux');
});

test('generated progress preserves author Markdown and strips only its exact source-bound suffix', () => {
  const original = '---\nschemaVersion: 1\nid: feature-one\ntitle: Implement feature\nstatus: ready\n---\n# Goal\n\nPreserve this text.\n';
  const record = trackingSharedRecord({ sourceMarkdown: original, taskNote: 'feature-tasks/task-1.md', progress: 'Waiting for your answer.' });
  const generated = renderSharedSource(record), parsed = parseFeature(generated);
  assert.equal(acceptedSharedBody(parsed), parseFeature(original).body);
  assert.match(parsed.body, /## Worker progress/); assert.equal(parsed.data.werkTask, '[[feature-tasks/task-1]]');
  assert.equal(acceptedSharedBody(parseFeature(generated.replace('Preserve this text.', 'Teammate edit.'))).includes('Teammate edit.'), true);
  assert.notEqual(acceptedSharedBody(parseFeature(generated.replace('Waiting for your answer.', 'Tampered progress.'))), parseFeature(original).body);
});


test('a pending reply is persisted again after a save failure before any continuation side effect', async () => {
  const f = await fixture(); f.answer(); f.controls.saveFailure = true;
  await assert.rejects(f.sync(), /Disk unavailable/); assert.equal(f.admissions.size, 0);
  assert.equal(f.record.task.response.status, 'pending');
  await assert.rejects(f.sync(), /Disk unavailable/); assert.equal(f.admissions.size, 0);
  f.controls.saveFailure = false; f.publish(await f.sync()); assert.equal(f.admissions.size, 1);
});

test('editing the claimed FR blocks a ready Task continuation until its frozen source is restored', async () => {
  const f = await fixture(); f.answer();
  f.files.set(f.record.sourcePath, f.record.sourceMarkdown + '\nChanged requirements');
  assert.match((await f.sync()).error, /changed before continuation/); assert.equal(f.admissions.size, 0);
  f.restart(); f.files.set(f.record.sourcePath, f.record.sourceMarkdown);
  f.publish(await f.sync()); assert.equal(f.admissions.size, 1);
});


test('an immediate repeat failure with the same error publishes a new resumable Task checkpoint', async () => {
  const f = await fixture(); f.fail('2'); f.record.status = 'failed'; f.record.error = 'same failure';
  await f.reconcile();
  const first = f.record.task.path; assert.equal(f.record.task.identity.action, 'resume');
  f.answer('Retry with the corrected local service'); f.controls.nextFailure = true;
  await f.reconcile(); assert.equal(f.admissions.size, 1);
  await f.reconcile();
  assert.notEqual(f.record.task.path, first); assert.equal(f.record.task.identity.turnId, 'turn-3');
  assert.equal(readTaskNote(f.files.get(f.record.task.path), f.record.task.identity).status, 'open');
  assert.equal(f.admissions.size, 1);
});
