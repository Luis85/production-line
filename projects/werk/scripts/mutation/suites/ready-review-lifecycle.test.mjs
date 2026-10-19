import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SharedReadyReviewLifecycle, sharedReviewCheckpoint, sharedReviewInput } from '../../../.mutation-build/worker/application/shared-ready-review.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const pass = () => ({ passed: true, summary: 'Requirements clarified.', findings: [] });
/** @returns {import('../../../src/worker/application/shared-feature-state.js').SharedFeatureRecord} */
function recordFixture() {
  const commit = 'a'.repeat(40), descriptor = path => ({ path, sha256: hash(path) }), rules = () => ({ chat: [], patch: [] });
  /** @type {import('../../../src/worker/application/shared-feature-state.js').SharedFeatureRecord} */
  const record = {
    id: 'keyboard', name: 'keyboard.md', title: 'Keyboard', status: 'reviewing_ready', owner: 'worker', isLocal: true,
    sourceCommit: commit, updatedAt: '2000-01-01T00:00:00.000Z', ready: null, done: null, featureBranch: null, reviewNote: null,
    publication: 'synced', error: null, taskId: 'reserved', claimed: true, submitted: false,
    binding: { enabled: true, repositoryId: 'repository', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 1000 },
    sourcePath: 'features/keyboard.md', sourceMarkdown: '# Keyboard request', remoteRevision: '', inputHash: hash('accepted'),
    accepted: { id: 'keyboard', templateId: 'review-v1', title: 'Keyboard', provider: 'codex-cli', mode: 'patch', priority: 1, paths: ['src/keyboard.ts'], message: 'Keyboard request', metadata: {}, criteria: [], sections: { goal: '', context: '', verificationPlan: '' } },
    workflow: {
      schemaVersion: 1, commit, configuration: { schemaVersion: 1, id: 'features', requestsDirectory: 'features', reviewDirectory: 'reviews', template: 'template.md', base: 'features.base', readyCheck: 'ready.json', doneCheck: 'done.json', readyReviewPrompt: 'reviewer.md' },
      template: '', readyCheck: { schemaVersion: 1, id: 'ready', version: 1, stage: 'ready', rules: rules() }, doneCheck: { schemaVersion: 1, id: 'done', version: 1, stage: 'done', rules: rules() },
      policy: { schemaVersion: 1, id: 'policy', version: 1, ready: rules(), done: rules(), rework: { maxAttempts: 1 }, reviewer: { enabled: false, provider: 'codex-cli', maxAttempts: 1 } }, policyDigest: hash('policy'),
      files: { configuration: descriptor('.werk/feature-workflow.json'), template: descriptor('template.md'), base: descriptor('features.base'), readyCheck: descriptor('ready.json'), doneCheck: descriptor('done.json'), readyReviewPrompt: descriptor('reviewer.md') },
      readyReview: { schemaVersion: 1, commit, prompt: { path: 'reviewer.md', content: 'Challenge assumptions.', sha256: hash('Challenge assumptions.') } },
    },
  };
  return record;
}
function harness() {
  const record = recordFixture(); record.readyReviewState = sharedReviewCheckpoint(record);
  const events = [], writes = [];
  /** @type {import('../../../src/worker/application/ready-review-contracts.js').ReadyReviewExecutionView | undefined} */
  let execution;
  const render = value => JSON.stringify({ status: value.status, progress: value.progress, error: value.error, updatedAt: value.updatedAt, ready: value.ready, generation: value.readyReviewState.generation, reviewStatus: value.readyReviewState.status, result: value.readyReviewState.result, source: value.sourceMarkdown });
  record.publishedSource = render(record); record.remoteRevision = record.publishedState = hash(record.publishedSource);
  const controls = { remote: record.publishedSource, head: record.sourceCommit, admitted: true, confirmSchedule: true, publication: 'confirmed', response: { sourceMarkdown: '# Revised request', answer: 'Wrap to the first item.', status: 'ready' } };
  const eligible = { valid: true, input: { ...record.accepted, message: 'Revised request with answers.' }, inputHash: hash('revised'), errors: [] };
  const ready = { valid: true, input: structuredClone(record.accepted), inputHash: hash('ready'), errors: [] };
  const repository = {
    async head() { return controls.head; }, async readBlob() { return controls.remote; }, async listRequests() { return []; },
    async publishLifecycle() { throw Error('Unused port'); }, async publishPatch() { throw Error('Unused port'); },
  };
  /** @type {import('../../../src/worker/application/shared-feature-state.js').SharedIntakePorts} */
  const ports = {
    async load() { throw Error('Unused port'); }, async save() {}, repository: () => repository, async loadWorkflow() { return record.workflow; },
    source: () => ({ title: 'Keyboard', status: 'ready' }), renderSource: render,
    async submit() { throw Error('Reviewer may not submit implementation'); }, inspect: () => undefined, canAdmit: () => controls.admitted,
    ready: () => { events.push('DoR'); return ready; }, readyReviewEligible: () => eligible, readyReviewResponse: () => controls.response,
    readyReview: {
      inspect: input => execution?.operationId === input.operationId ? execution : undefined,
      async schedule(input) {
        events.push('review'); assert.ok(events.includes('save'), 'Reviewer intent must be persisted before admission.');
        const attempt = { operationId: input.operationId, sessionId: 'review-session', turnId: 'review-turn', runId: 'review-run' };
        if (controls.confirmSchedule) execution = { ...attempt, state: 'queued' };
        return attempt;
      },
    },
  };
  const lifecycle = new SharedReadyReviewLifecycle(ports, async () => { events.push('save'); }, async () => {
    events.push('publish'); writes.push(render(record));
    if (controls.publication === 'unconfirmed') return;
    if (controls.publication === 'conflict') { delete record.readyReviewState.implementationReady; return; }
    record.remoteRevision = record.publishedState = hash(controls.publication === 'different' ? 'another rendered state' : render(record));
    controls.remote = render(record); record.publishedSource = controls.remote;
  });
  return { record, controls, ports, events, writes, eligible, ready,
    tick: () => lifecycle.reconcile(record, repository, new AbortController().signal),
    get execution() { return execution; }, set execution(value) { execution = value; },
    revise() { controls.head = 'b'.repeat(40); controls.remote = 'A pushed authored revision'; },
  };
}

test('the phase contract authorizes legacy or already-cleared requests without touching reviewer ports', async () => {
  for (const configured of [false, true]) {
    const f = harness(); if (configured) f.record.readyReviewState.implementationReady = true; else delete f.record.readyReviewState;
    delete f.ports.readyReview; assert.equal(await f.tick(), true); assert.deepEqual(f.events, []);
  }
});

test('review operation identity is stable within a generation and forwards explicit profile selections', () => {
  const record = recordFixture();
  for (const selection of [{ definitionId: 'local-profile' }, { definitionRef: 'shared-profile' }, { agent: 'reviewer', useInstructionsOnly: false }, { useInstructionsOnly: true }]) {
    const selected = { ...record, accepted: { ...record.accepted, ...selection } }, input = sharedReviewInput(selected, 'An answer.', 1);
    for (const [key, value] of Object.entries(selection)) assert.equal(input[key], value);
    assert.deepEqual(input, sharedReviewInput(selected, 'An answer.', 1));
    assert.notEqual(input.operationId, sharedReviewInput(selected, 'An answer.', 2).operationId);
    const other = { ...selected, id: 'another-feature' }; assert.notEqual(input.operationId, sharedReviewInput(other, 'An answer.', 1).operationId);
  }
  assert.equal(Object.hasOwn(sharedReviewInput(record, '', 1), 'useInstructionsOnly'), false);
});

test('each review phase returns its actual implementation permission and keeps idle polls quiet', async () => {
  const f = harness(); assert.equal(await f.tick(), false); assert.equal(f.record.readyReviewState.status, 'queued');
  assert.match(f.record.progress, /queued before Definition of Ready/); assert.notEqual(f.record.updatedAt, '2000-01-01T00:00:00.000Z');
  const publications = f.writes.length; assert.equal(await f.tick(), false); assert.equal(f.writes.length, publications);
  f.execution.state = 'running'; assert.equal(await f.tick(), false); assert.equal(f.record.readyReviewState.status, 'running'); assert.match(f.record.progress, /model is reviewing/);
  f.execution = { ...f.execution, state: 'completed', result: pass() }; assert.equal(await f.tick(), true);
  assert.deepEqual(f.record.ready, { passed: true, issues: [] }); assert.equal(f.record.status, 'queued'); assert.equal(f.record.error, null);
  assert.equal(f.record.readyReviewState.implementationReady, true); assert.match(f.record.progress, /Implementation is queued/);
  assert.equal(f.events.filter(event => event === 'DoR').length, 1); assert.equal(f.events.filter(event => event === 'review').length, 1);
});

test('missing review integration or a missing source produces actionable errors before payment', async () => {
  for (const key of ['readyReview', 'readyReviewEligible', 'readyReviewResponse']) {
    const f = harness(); delete f.ports[key]; await assert.rejects(f.tick(), /Update the worker before continuing/); assert.equal(f.events.includes('review'), false);
  }
  const f = harness(); f.controls.remote = null; await assert.rejects(f.tick(), /Restore it before continuing/); assert.equal(f.events.includes('review'), false);
});

test('draft or invalid pushed revisions cannot become a new paid generation', async () => {
  const f = harness(); f.revise(); f.controls.response.status = 'draft'; assert.equal(await f.tick(), false); assert.equal(f.record.readyReviewState.generation, 1);
  f.controls.response.status = 'ready'; f.eligible.valid = false; f.eligible.errors = [{ code: 'unsafe', message: 'Approved paths must stay in the project.' }];
  await assert.rejects(f.tick(), /Approved paths must stay in the project/); assert.equal(f.events.includes('review'), false);
  f.eligible.valid = true;
  for (const key of ['input', 'inputHash']) {
    const original = f.eligible[key]; f.eligible[key] = undefined;
    await assert.rejects(f.tick(), /Approved paths must stay in the project/); f.eligible[key] = original;
  }
});

test('a revised claim must be acknowledged in both remote and rendered state before review admission', async () => {
  for (const publication of ['unconfirmed', 'different']) {
    const f = harness(); f.revise(); f.controls.publication = publication;
    assert.equal(await f.tick(), false); assert.equal(f.record.readyReviewState.generation, 2); assert.equal(f.events.includes('review'), false);
    assert.match(f.record.progress, /committed changes are queued/); assert.equal(f.record.status, 'reviewing_ready');
  }
});

test('budget and capacity holds preserve the reservation without claiming implementation permission', async () => {
  for (const held of [false, true]) {
    const f = harness(); f.controls.admitted = held;
    if (held) f.ports.admissionHold = () => ({ code: 'budget', message: 'The worker share is exhausted until tomorrow.' });
    assert.equal(await f.tick(), false); assert.equal(f.events.includes('review'), false);
    assert.match(f.record.progress, held ? /share is exhausted/ : /waiting for worker capacity/);
  }
});

test('an unconfirmed accepted review is held and cannot be scheduled again without new input', async () => {
  const f = harness(); f.controls.confirmSchedule = false;
  await assert.rejects(f.tick(), /admission is not confirmed/); assert.equal(f.events.filter(event => event === 'review').length, 1);
  assert.equal(await f.tick(), false); assert.equal(f.record.readyReviewState.status, 'failed'); assert.match(f.record.error, /execution evidence is unavailable/);
  assert.equal(f.events.filter(event => event === 'review').length, 1);
});

test('failed or incomplete executions never promote an attached pass and retain useful recovery steps', async () => {
  /** @type {[import('../../../src/worker/application/ready-review-contracts.js').ReadyReviewExecutionView['state'], string | undefined, RegExp][]} */
  const cases = [
    ['interrupted', 'worker_restarted', /worker restarted/], ['failed', 'protocol', /invalid Ready Check result/],
    ['interrupted', 'interrupted', /was interrupted/], ['failed', 'quota', /account reached its allowance/],
    ['failed', 'consumption_limit', /consumption limit stopped/], ['failed', 'authentication', /could not authenticate/], ['failed', 'rate_limit', /reached its current rate limit/],
    ['failed', 'unavailable', /connection was unavailable/], ['failed', undefined, /without a validated result/],
  ];
  for (const [state, code, message] of cases) {
    const f = harness(); await f.tick(); f.execution = { ...f.execution, state, error: code, result: pass() };
    assert.equal(await f.tick(), false); assert.equal(f.record.status, 'blocked'); assert.equal(f.record.readyReviewState.status, 'failed');
    assert.match(f.record.error, message); assert.match(f.record.error, /Answers.*ready.*commit and push/); assert.equal(f.events.includes('DoR'), false);
  }
  const f = harness(); await f.tick(); f.execution = { ...f.execution, state: 'completed' };
  assert.equal(await f.tick(), false); assert.equal(f.record.status, 'blocked'); assert.equal(f.events.includes('DoR'), false);
});

test('waiting findings do not reprocess old model evidence and only a revised source carries its prior assessment', async () => {
  const f = harness(); await f.tick();
  /** @type {import('../../../src/worker/application/ready-review-contracts.js').ReadyReviewResult} */
  const result = { passed: false, summary: 'Needs clarification.', findings: [{ kind: 'question', blocking: true, message: 'Wrap?' }] };
  f.execution = { ...f.execution, state: 'completed', result }; assert.equal(await f.tick(), false);
  assert.match(f.record.progress, /Answer the Ready Check questions/); const publications = f.writes.length;
  assert.equal(await f.tick(), false); assert.equal(f.writes.length, publications); assert.equal(f.events.includes('DoR'), false);
  f.revise(); assert.equal(await f.tick(), false); assert.deepEqual(f.record.readyReviewState.input.previousAssessment, result);
  assert.equal(f.record.sourceCommit, f.controls.head); assert.equal(f.record.sourceMarkdown, f.controls.response.sourceMarkdown);
});

test('DoR failures remain blocking with bounded meaningful diagnostics, including exact UTF-8 boundaries', async () => {
  for (const message of ['Fix verification details.', 'x'.repeat(256), '界'.repeat(100)]) {
    const f = harness(); await f.tick(); f.execution = { ...f.execution, state: 'completed', result: pass() };
    f.ready.valid = false; f.ready.errors = Array.from({ length: 10 }, () => ({ code: 'missing', message }));
    assert.equal(await f.tick(), false); assert.equal(f.record.status, 'waiting_ready_input'); assert.equal(f.record.ready.passed, false);
    assert.equal(f.record.ready.issues.length, 8); assert.match(f.record.progress, /Definition of Ready still needs changes/);
    assert.equal(f.record.ready.issues[0], message.length <= 256 && Buffer.byteLength(message) <= 256 ? message : '界'.repeat(85) + '…');
  }
});


test('idle review polls preserve their timestamp and do not publish as time advances', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-18T00:00:00Z') });
  const f = harness(); await f.tick(); const updatedAt = f.record.updatedAt, writes = f.writes.length;
  t.mock.timers.tick(1000); assert.equal(await f.tick(), false);
  assert.equal(f.record.updatedAt, updatedAt); assert.equal(f.writes.length, writes);
});

test('pushed edits during queued or running review never grant implementation permission or overlap review work', async () => {
  for (const state of /** @type {const} */ (['queued', 'running'])) {
    const f = harness(); await f.tick(); f.execution.state = state;
    const operation = f.record.readyReviewState.input.operationId, before = f.record.sourceMarkdown, writes = f.writes.length;
    f.revise(); assert.equal(await f.tick(), false);
    assert.equal(f.record.sourceMarkdown, before); assert.equal(f.record.readyReviewState.input.operationId, operation);
    assert.equal(f.events.filter(event => event === 'review').length, 1); assert.equal(f.writes.length, writes);
  }
});

test('same semantic revision and an incompatible revised profile cannot cross readiness admission', async () => {
  const unchanged = harness(); unchanged.revise(); unchanged.eligible.inputHash = unchanged.record.readyReviewState.reviewedHash;
  assert.equal(await unchanged.tick(), false); assert.equal(unchanged.events.includes('review'), false); assert.equal(unchanged.record.readyReviewState.generation, 1);
  const incompatible = harness(); incompatible.revise(); incompatible.ports.admissionIssue = () => 'This instruction profile requires another provider.';
  await assert.rejects(incompatible.tick(), /instruction profile requires another provider/);
  assert.equal(incompatible.events.includes('review'), false); assert.equal(incompatible.record.sourceMarkdown, '# Keyboard request');
});

test('a committed answer arriving before result projection carries the completed assessment into its new generation', async () => {
  const f = harness(); await f.tick();
  const result = { passed: false, summary: 'Choose an edge behavior.', findings: [{ kind: /** @type {const} */ ('question'), message: 'Wrap at the final item?', blocking: true }] };
  f.execution = { ...f.execution, state: 'completed', result }; f.revise(); assert.equal(await f.tick(), false);
  assert.deepEqual(f.record.readyReviewState.input.previousAssessment, result);
  assert.equal(f.events.filter(event => event === 'review').length, 2); assert.equal(f.record.readyReviewState.generation, 2);
  assert.equal(f.events.includes('DoR'), false);
});

test('failed review generations and cancelled pass publications cannot authorize implementation', async () => {
  const failed = harness(); await failed.tick(); failed.record.readyReviewState.status = 'failed';
  failed.execution = { ...failed.execution, state: 'completed', result: pass() };
  assert.equal(await failed.tick(), false); assert.equal(failed.events.includes('DoR'), false);
  const conflict = harness(); await conflict.tick(); conflict.execution = { ...conflict.execution, state: 'completed', result: pass() };
  conflict.controls.publication = 'conflict'; assert.equal(await conflict.tick(), false);
  assert.equal(conflict.record.readyReviewState.implementationReady, undefined);
});
