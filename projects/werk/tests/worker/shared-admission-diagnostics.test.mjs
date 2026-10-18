import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { SharedFeatureLifecycle } from '../../src/worker/dist/worker/application/shared-feature-lifecycle.js';
import { sharedHash } from '../../src/worker/dist/worker/application/shared-feature-notes.js';
import { renderSharedSource } from '../../src/worker/dist/worker/infrastructure/features/shared-source.js';
import { DomainError } from '../../src/worker/dist/shared/errors.js';
import { trackingSharedRecord } from './tracking-fixtures.mjs';
import { fixture as sharedFixture } from './shared-feature-fixture.mjs';
import { SharedFeatureJournal } from '../../src/worker/dist/worker/infrastructure/journal/shared-features.js';

function fixture() {
  let record = trackingSharedRecord({ claimed: false, submitted: false, sourceMarkdown: "---\nschemaVersion: 1\nid: feature-one\ntitle: Implement feature\nstatus: ready\n---\n# Implement feature\n" });
  const files = new Map([[record.sourcePath, record.sourceMarkdown]]);
  record.remoteRevision = sharedHash(record.sourceMarkdown);
  /** @type {import('../../src/worker/application/shared-feature-state.js').SharedExecution | undefined} */
  let execution;
  /** @type {import('../../src/worker/application/shared-feature-state.js').SharedAdmissionHold | undefined} */
  let hold;
  const controls = { failure: true, acceptThenThrow: false, loseClaim: false, loseDiagnostic: false, editDuringSubmit: false, abortDuringSubmit: false };
  /** @type {import('../../src/worker/application/shared-feature-state.js').LifecycleWrite[]} */
  const writes = [];
  const receipts = new Map(), submittedIds = [];
  const stop = new AbortController();
  const unexpected = () => { throw Error('Unexpected lifecycle boundary'); };
  /** @type {import('../../src/worker/application/shared-feature-state.js').SharedRepositoryPort} */
  const repository = {
    head: async () => 'a'.repeat(40), readBlob: async (_commit, path) => files.get(path) ?? null,
    listRequests: unexpected, publishPatch: unexpected,
    async publishLifecycle(write) {
      writes.push(structuredClone(write));
      if (!receipts.has(write.operationId)) {
        for (const item of [write.request, ...write.artifacts]) {
          const current = files.get(item.path);
          if ((current === undefined ? null : sharedHash(current)) !== item.expectedRevision) throw new DomainError('conflict', 'A teammate changed the source or diagnostic.');
        }
        for (const item of [write.request, ...write.artifacts]) files.set(item.path, item.content);
        receipts.set(write.operationId, { commit: 'a'.repeat(40), head: 'a'.repeat(40) });
      }
      if (!write.artifacts.length && controls.loseClaim || write.artifacts.length && controls.loseDiagnostic) throw Error('Publication acknowledgement lost');
      return receipts.get(write.operationId);
    },
  };
  /** @type {import('../../src/worker/application/shared-feature-state.js').SharedIntakePorts} */
  const ports = {
    load: unexpected, save: unexpected, loadWorkflow: unexpected, ready: unexpected, source: unexpected,
    repository: () => repository, renderSource: renderSharedSource, inspect: () => execution,
    canAdmit: () => !hold, admissionHold: () => hold,
    async submit(value) {
      submittedIds.push(value.taskId);
      if (controls.editDuringSubmit) files.set(record.sourcePath, files.get(record.sourcePath) + '\nA teammate changed this request.\n');
      if (controls.abortDuringSubmit) stop.abort();
      if (controls.acceptThenThrow || !controls.failure) execution ??= { status: 'queued', summary: null, patch: null, request: null };
      if (controls.acceptThenThrow) throw Error('Admission acknowledgement lost');
      if (controls.failure) throw new DomainError('too_large', 'Approved file exceeds the 24,000-byte capture limit.');
    },
  };
  let saved = structuredClone(record);
  const save = async () => { saved = structuredClone(record); };
  let lifecycle = new SharedFeatureLifecycle(ports, save);
  return {
    get record() { return record; }, get execution() { return execution; }, controls, files, writes, receipts, submittedIds,
    reconcile: () => lifecycle.reconcile(record, stop.signal),
    restart() { record = structuredClone(saved); lifecycle = new SharedFeatureLifecycle(ports, save); },
    setHold(value) { hold = value; },
    note() {
      assert.ok(record.taskNote);
      const markdown = files.get(record.taskNote); assert.ok(markdown);
      const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown); assert.ok(match);
      return { markdown, data: parse(match[1]) };
    },
  };
}

test('preparation failure publishes one informational Task and the original claimed Feature Request tracks it', async () => {
  const f = fixture(); await f.reconcile();
  assert.equal(f.record.claimed, true); assert.equal(f.record.submitted, false);
  assert.equal(f.record.status, 'blocked'); assert.equal(f.record.publication, 'synced');
  const note = f.note();
  assert.equal(note.data.type, 'Task'); assert.equal(note.data.status, 'blocked');
  assert.equal(note.data.featureId, f.record.id); assert.equal(note.data.action, undefined);
  assert.equal(note.data.pendingId, undefined); assert.doesNotMatch(note.markdown, /## Answer/);
  assert.match(note.markdown, /24,000-byte capture limit/);
  assert.match(f.files.get(f.record.sourcePath), /werkTask:/);
  const path = f.record.taskNote, receiptCount = f.receipts.size;
  await f.reconcile(); f.restart(); await f.reconcile();
  assert.equal(f.record.taskNote, path); assert.equal(f.receipts.size, receiptCount);
  assert.equal(new Set(f.submittedIds).size, 1); assert.equal(f.execution, undefined);
});

test('recovered admission retains the same identity and removes its obsolete diagnostic link without deleting the note', async () => {
  const f = fixture(); await f.reconcile(); const path = f.record.taskNote, markdown = f.note().markdown;
  f.restart(); f.controls.failure = false; await f.reconcile();
  assert.equal(f.record.submitted, true); assert.equal(f.record.status, 'queued'); assert.equal(f.record.error, null);
  assert.equal(f.record.taskNote, null); assert.equal(f.files.get(path), markdown);
  assert.equal(new Set(f.submittedIds).size, 1); assert.ok(f.execution);
  assert.match(f.files.get(f.record.sourcePath), /werkTask: null/);
});

test('lost admission acknowledgement never creates a failure Task for an execution that already exists', async () => {
  const f = fixture(); f.controls.acceptThenThrow = true; await f.reconcile();
  assert.ok(f.execution); assert.equal(f.record.submitted, false); assert.equal(f.record.taskNote, undefined);
  assert.ok(f.writes.every(write => write.artifacts.length === 0));
  f.restart(); f.controls.acceptThenThrow = false; f.controls.failure = false; await f.reconcile();
  assert.equal(f.record.submitted, true); assert.equal(new Set(f.submittedIds).size, 1);
  assert.equal(f.record.taskNote, undefined);
});

test('unconfirmed claim publication retains the exact receipt without admission or a diagnostic', async () => {
  const f = fixture(); f.controls.loseClaim = true; await f.reconcile();
  const pending = structuredClone(f.record.pending);
  assert.ok(pending); assert.equal(f.record.claimed, false); assert.equal(f.submittedIds.length, 0);
  assert.equal(f.record.taskNote, undefined);
  f.restart(); await f.reconcile(); assert.deepEqual(f.record.pending, pending);
  assert.equal(f.submittedIds.length, 0); assert.equal(f.receipts.size, 1);
});

test('lost diagnostic acknowledgement replays its persisted receipt before another admission attempt', async () => {
  const f = fixture(); f.controls.loseDiagnostic = true; await f.reconcile();
  const pending = structuredClone(f.record.pending), path = f.record.taskNote;
  assert.ok(pending?.artifacts.length); assert.equal(f.record.publication, 'error');
  const submitted = f.submittedIds.length;
  f.restart(); await f.reconcile();
  assert.deepEqual(f.record.pending, pending); assert.equal(f.submittedIds.length, submitted);
  f.controls.loseDiagnostic = false; await f.reconcile();
  assert.equal(f.record.pending, undefined); assert.equal(f.record.publication, 'synced');
  assert.equal(f.record.taskNote, path);
  assert.equal(new Set(f.writes.flatMap(write => write.artifacts.map(item => item.path))).size, 1);
});

test('a teammate source edit before admission is preserved without a manufactured Task', async () => {
  const f = fixture(); f.setHold({ code: 'paused', message: 'Starts are paused. Resume when ready.' }); await f.reconcile();
  f.setHold(undefined); const edited = f.files.get(f.record.sourcePath) + '\nTeam edit\n'; f.files.set(f.record.sourcePath, edited);
  const writes = f.writes.length; await f.reconcile();
  assert.equal(f.submittedIds.length, 0); assert.equal(f.writes.length, writes);
  assert.equal(f.files.get(f.record.sourcePath), edited); assert.match(f.record.error, /changed before admission/);
});

test('a teammate edit racing preparation failure cannot be overwritten by diagnostic publication', async () => {
  const f = fixture(); f.controls.editDuringSubmit = true; await f.reconcile();
  assert.equal(f.record.publication, 'error'); assert.ok(f.record.pending);
  assert.match(f.files.get(f.record.sourcePath), /A teammate changed this request/);
  assert.equal(f.files.has(f.record.taskNote), false);
  const pending = structuredClone(f.record.pending), submissions = f.submittedIds.length;
  f.restart(); await f.reconcile();
  assert.deepEqual(f.record.pending, pending); assert.equal(f.submittedIds.length, submissions);
});

test('owned operational holds remain queued with a non-actionable Task until the same request can be admitted', async () => {
  const f = fixture(); f.setHold({ code: 'budget', message: 'Wait for the UTC allowance reset; this request retries automatically.' });
  await f.reconcile(); assert.equal(f.record.status, 'queued'); assert.equal(f.record.submitted, false);
  assert.equal(f.submittedIds.length, 0); assert.match(f.note().markdown, /UTC allowance reset/);
  assert.equal(f.note().data.status, 'waiting'); assert.equal(f.note().data.action, undefined);
  assert.match(f.note().markdown, /checks again automatically/);
  f.setHold(undefined); f.controls.failure = false; await f.reconcile();
  assert.equal(f.record.submitted, true); assert.equal(f.record.taskNote, null);
});

test('shutdown during admission does not publish a new diagnostic', async () => {
  const f = fixture(); f.controls.abortDuringSubmit = true; await f.reconcile();
  assert.equal(f.record.submitted, false); assert.equal(f.record.taskNote, undefined);
  assert.equal(f.writes.length, 1); assert.equal(f.record.pending, undefined);
});

test('a recurring admission hold safely reuses its original diagnostic across restart', async () => {
  const f = fixture();
  const paused = { code: 'paused', message: 'Starts are paused; resume starts to continue.' };
  f.setHold(paused); await f.reconcile(); const firstPath = f.record.taskNote, firstContent = f.note().markdown;
  f.setHold({ code: 'budget', message: 'Wait for the UTC allowance reset.' }); await f.reconcile();
  assert.notEqual(f.record.taskNote, firstPath);
  f.restart(); f.setHold(paused); await f.reconcile();
  assert.equal(f.record.publication, 'synced'); assert.equal(f.record.pending, undefined);
  assert.equal(f.record.taskNote, firstPath); assert.equal(f.note().markdown, firstContent);
  assert.equal(f.files.size, 3); assert.equal(f.submittedIds.length, 0);
});

test('a teammate edit to a historical admission diagnostic is preserved when its hold recurs', async () => {
  const f = fixture();
  const paused = { code: 'paused', message: 'Starts are paused; resume starts to continue.' };
  f.setHold(paused); await f.reconcile(); const path = f.record.taskNote;
  f.setHold({ code: 'budget', message: 'Wait for the UTC allowance reset.' }); await f.reconcile();
  const source = f.files.get(f.record.sourcePath), edited = f.files.get(path) + '\nTeam context\n'; f.files.set(path, edited);
  f.setHold(paused); await f.reconcile();
  assert.equal(f.record.publication, 'error'); assert.match(f.record.error, /changed the admission diagnostic/);
  assert.equal(f.record.pending, undefined); assert.equal(f.files.get(path), edited);
  assert.equal(f.files.get(f.record.sourcePath), source); assert.equal(f.submittedIds.length, 0);
});

test('the durable journal restores waiting admission notes and guarded recurring-note outboxes', async t => {
  const f = await sharedFixture(t); f.controls.claimAckBlocked = true; await f.intake.sync();
  let hold = { code: 'paused', message: 'Starts are paused; resume starts to continue.' };
  Object.assign(f.controls, { admissionHold: () => hold });
  f.controls.claimAckBlocked = false; await f.intake.sync();
  const first = (await f.state()).records[0];
  assert.equal(first.submitted, false); assert.match(first.diagnostic.markdown, /status: waiting/);
  await f.restart(); assert.equal(f.tasks.size, 0);
  hold = { code: 'budget', message: 'Wait for the UTC allowance reset.' }; await f.intake.sync();
  hold = { code: 'paused', message: 'Starts are paused; resume starts to continue.' };
  f.controls.claimAckBlocked = true; await f.intake.sync();
  const journal = new SharedFeatureJournal(f.directory), state = await journal.load();
  const pending = state.records[0].pending; assert.ok(pending);
  assert.equal(pending.artifacts[0].path, first.diagnostic.path);
  assert.equal(pending.artifacts[0].expectedRevision, sharedHash(first.diagnostic.markdown));
  await f.restart(); await f.intake.sync();
  assert.deepEqual((await f.state()).records[0].pending, pending); assert.equal(f.tasks.size, 0);
  f.controls.claimAckBlocked = false; await f.intake.sync();
  assert.equal((await journal.load()).records[0].pending, undefined);
  const invalid = structuredClone(state); invalid.records[0].pending.artifacts[0].expectedRevision = '0'.repeat(64);
  await journal.save(invalid); await assert.rejects(journal.load(), /Invalid shared artifact outbox/);
  await journal.save(state);
});
