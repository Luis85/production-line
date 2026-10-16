import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedFeatureIntake } from '../../src/worker/dist/worker/application/shared-feature-intake.js';
import { bindingKey } from '../../src/worker/dist/worker/application/shared-feature-state.js';
import { sharedHash } from '../../src/worker/dist/worker/application/shared-feature-notes.js';
import { SharedFeatureJournal } from '../../src/worker/dist/worker/infrastructure/journal/shared-features.js';
import { WorkerRequestJournal } from '../../src/worker/dist/worker/infrastructure/journal/requests.js';
import { defaultFeatureWorkflow, defaultFeatureCheck, featureGateInput } from '../../src/worker/dist/worker/application/feature-workflow.js';
import { validateFeatureReadiness, loadFeatureWorkflowSnapshot } from '../../src/worker/dist/worker/infrastructure/features/workflow.js';
import { sharedSource, renderSharedSource } from '../../src/worker/dist/worker/infrastructure/features/shared-source.js';

const template = `---
schemaVersion: 1
templateId: shared-fixture-v1
title: Describe the feature
status: draft
mode: patch
paths: []
---
# Goal
<!-- Describe the behavior. -->
## Context
<!-- Describe constraints. -->
## Acceptance criteria
- [ ] <!-- Describe an observable result. -->
## Verification plan
<!-- Describe verification. -->
`;
const source = `---
schemaVersion: 1
templateId: shared-fixture-v1
id: shared-navigation
title: Shared navigation
status: ready
mode: patch
paths:
  - src/navigation.ts
---
# Goal
Support keyboard navigation.
## Context
Preserve pointer interactions.
## Acceptance criteria
- Arrow keys move the active selection.
## Verification plan
Review the proposed patch and run the keyboard test suite.
`;
const sourcePath = 'features/navigation.md';
const patch = 'diff --git a/src/navigation.ts b/src/navigation.ts\n--- a/src/navigation.ts\n+++ b/src/navigation.ts\n@@ -1 +1 @@\n-before\n+after\n';

async function fixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-shared-coordinator-')));
  const controls = { claimAckBlocked: false, submitAckBlocked: false, patchAckBlocked: false, changeAfterClaim: false, saveBlocked: false, admit: true, inspect: null, repositoryFailures: 0 };
  const events = [], repositories = new Map(), tasks = new Map();
  const lifecycleAttempts = [], patchAttempts = [], submits = [];
  let counter = 0, primaryExecutions = 0, featureCommits = 0, journal, requests, intake, headGate;
  const nextCommit = () => (++counter).toString(16).padStart(40, '0');
  function addRepository(id = 'shared', content = source) {
    const configuration = defaultFeatureWorkflow(), done = defaultFeatureCheck('done');
    done.rules.patch = options.doneRules ?? [];
    const files = new Map(Object.entries({ '.werk/feature-workflow.json': JSON.stringify(configuration), [configuration.readyCheck]: JSON.stringify(defaultFeatureCheck('ready')), [configuration.doneCheck]: JSON.stringify(done), [configuration.template]: template, [configuration.base]: 'views:\n  - type: table\n    name: Features\n', [sourcePath]: content }));
    const head = nextCommit(), repo = { head, files, versions: new Map([[head, new Map(files)]]), lifecycle: new Map(), features: new Map() };
    repositories.set(id, repo); return repo;
  }
  addRepository('shared', options.source ?? source);
  function commitFiles(id, edits) {
    const repo = repositories.get(id); for (const [path, content] of Object.entries(edits)) content === null ? repo.files.delete(path) : repo.files.set(path, content);
    repo.head = nextCommit(); repo.versions.set(repo.head, new Map(repo.files)); return repo.head;
  }
  function repository(binding) {
    if (controls.repositoryFailures > 0) { controls.repositoryFailures--; throw Error('Fixture repository unavailable'); }
    const repo = repositories.get(binding.repositoryId); if (!repo) throw Error('Assigned repository unavailable');
    return {
      async head() { if (headGate) { const gate = headGate; headGate = undefined; gate.enter(); await gate.wait; } return repo.head; },
      async readBlob(commit, path) { assert.ok(repo.versions.has(commit), 'Reads must use a known immutable commit.'); return repo.versions.get(commit).get(path) ?? null; },
      async listRequests(commit) { return [...repo.versions.get(commit)].filter(([path]) => /^features\/[^/_][^/]*\.md$/.test(path)).map(([path, content]) => ({ path, name: path.slice('features/'.length), content, revision: sharedHash(content) })); },
      async publishLifecycle(write) {
        lifecycleAttempts.push(structuredClone(write)); events.push('lifecycle-attempt');
        let result = repo.lifecycle.get(write.operationId);
        if (!result) {
          assert.equal(sharedHash(repo.files.get(write.request.path)), write.request.expectedRevision, 'Lifecycle writes use compare-and-swap.');
          const edits = { [write.request.path]: write.request.content };
          for (const artifact of write.artifacts) { assert.equal(repo.files.get(artifact.path) ?? null, artifact.expectedRevision); edits[artifact.path] = artifact.content; }
          const commit = commitFiles(binding.repositoryId, edits); result = { commit, head: commit }; repo.lifecycle.set(write.operationId, result);
          if (controls.changeAfterClaim) { controls.changeAfterClaim = false; commitFiles(binding.repositoryId, { [write.request.path]: write.request.content + '\nAn external author changed this claimed request.\n' }); }
        }
        if (controls.claimAckBlocked) throw Error('Fixture lost claim acknowledgment');
        events.push('lifecycle-confirmed'); return result;
      },
      async publishPatch(write) {
        patchAttempts.push(structuredClone(write)); events.push('patch-attempt');
        let result = repo.features.get(write.operationId);
        if (!result) { result = { commit: nextCommit(), head: repo.head, branch: 'features/' + write.featureId }; repo.features.set(write.operationId, result); featureCommits++; }
        if (controls.patchAckBlocked) throw Error('Fixture lost feature publication acknowledgment');
        return result;
      },
    };
  }
  const ports = {
    load: () => journal.load(),
    async save(state) { if (controls.saveBlocked) throw Error('Fixture state write failure'); await journal.save(state); },
    repository,
    loadWorkflow: (repo, commit, configPath) => loadFeatureWorkflowSnapshot({ commit, configPath, readBlob: (at, path) => repo.readBlob(at, path) }),
    ready: (markdown, snapshot) => validateFeatureReadiness(markdown, snapshot.readyCheck, undefined, snapshot.template),
    source: sharedSource,
    renderSource: renderSharedSource,
    async submit(record) {
      assert.equal(record.claimed, true, 'Dispatch needs a remotely confirmed claim.'); assert.equal(record.pending, undefined);
      if (!tasks.has(record.taskId)) assert.equal(events.at(-1), 'lifecycle-confirmed', 'Claim acknowledgment precedes initial submission.');
      submits.push(record.taskId); events.push('submit');
      if (!tasks.has(record.taskId)) {
        const request = requests.ensure({ owner: { sessionId: 'local-' + record.taskId, rootTurnId: record.taskId, taskId: record.taskId }, input: featureGateInput(record.accepted), provider: { id: 'fixture', model: 'fixture-only', instruction: 'No external calls' }, policy: record.workflow.policy });
        tasks.set(record.taskId, { status: 'queued', requestId: request.id, summary: null, patch: null, currentTurnId: 'turn-' + record.taskId, runId: 'run-' + record.taskId });
      }
      if (controls.submitAckBlocked) throw Error('Fixture lost task admission acknowledgment');
    },
    inspect(id) { const task = tasks.get(id); if (!task) return undefined; const execution = { ...task, request: requests.get(task.requestId) }; return controls.inspect ? controls.inspect(execution) : execution; },
    canAdmit: () => controls.admit,
    admissionIssue: input => controls.admissionIssue?.(input),
  };
  async function open() { journal = new SharedFeatureJournal(directory); requests = new WorkerRequestJournal(directory); await requests.init(); intake = new SharedFeatureIntake(ports); await intake.init(); }
  await open();
  const config = { enabled: true, repositoryId: 'shared', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 1000 };
  await intake.configure(config, 0);
  t.after(async () => { await intake.close(); requests.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory, config, controls, events, repositories, tasks, lifecycleAttempts, patchAttempts, submits, addRepository, commitFiles,
    get intake() { return intake; }, get requests() { return requests; }, get primaryExecutions() { return primaryExecutions; }, get featureCommits() { return featureCommits; },
    async state() { return JSON.parse(await readFile(join(directory, 'shared-intake.json'), 'utf8')); },
    async restart() { await intake.close(); requests.close(); await open(); },
    async complete(id = [...tasks.keys()][0]) {
      const task = tasks.get(id), request = requests.get(task.requestId); assert.equal(task.status, 'queued'); primaryExecutions++;
      requests.evaluate(request.id, 'ready'); requests.bindTurn(request.id, task.currentTurnId); requests.prepareExecution(request.id, task.currentTurnId, task.runId); requests.startExecution(request.id, task.currentTurnId, task.runId);
      requests.recordResult(request.id, task.currentTurnId, task.runId, { type: 'completed', text: JSON.stringify({ summary: 'Fixture change; tests are not independently verified.', files: [{ path: 'src/navigation.ts', content: 'after\n' }] }) }, { 'output.protocolValid': true, 'output.patchPresent': true, 'output.changedFileCount': 1 });
      Object.assign(task, { status: 'review', patch, summary: 'Fixture proposed navigation change.' });
    },
    blockNextHead() { let enter, release; const entered = new Promise(resolve => { enter = resolve; }), wait = new Promise(resolve => { release = resolve; }); headGate = { enter, wait }; return { entered, release }; },
  };
}

test('a durable remote claim must be acknowledged before admission; lost acknowledgment replays the same outbox after restart', async t => {
  const f = await fixture(t); f.controls.claimAckBlocked = true;
  await f.intake.sync(); assert.equal(f.tasks.size, 0); assert.equal(f.submits.length, 0);
  const pending = await f.state(); assert.equal(pending.records[0].claimed, false); assert.ok(pending.records[0].pending);
  const operation = pending.records[0].pending.operationId;
  await f.restart(); f.controls.claimAckBlocked = false; await f.intake.sync();
  assert.equal(f.tasks.size, 1); assert.equal((await f.state()).records[0].submitted, true);
  assert.ok(f.lifecycleAttempts.filter(write => write.operationId === operation).length >= 2);
  assert.ok(f.events.indexOf('lifecycle-confirmed') < f.events.indexOf('submit'));
});

test('admission acknowledgment loss and restart retain one task identity and never create a second primary execution', async t => {
  const f = await fixture(t); f.controls.submitAckBlocked = true;
  await f.intake.sync(); assert.equal(f.tasks.size, 1); assert.equal((await f.state()).records[0].submitted, false);
  await f.restart(); f.controls.submitAckBlocked = false; await f.intake.sync();
  assert.equal(f.tasks.size, 1); assert.equal(new Set(f.submits).size, 1);
  await f.complete(); await f.intake.sync(); await f.restart(); await f.intake.sync();
  assert.equal(f.primaryExecutions, 1); assert.equal(f.featureCommits, 1);
  assert.equal(f.intake.view().requests[0].status, 'ready_for_review');
});

test('an author changing claimed source before first admission holds the request without executing or overwriting the edit', async t => {
  const f = await fixture(t); f.controls.changeAfterClaim = true;
  await f.intake.sync(); await f.restart(); await f.intake.sync();
  assert.equal(f.tasks.size, 0); assert.equal(f.submits.length, 0); assert.equal(f.featureCommits, 0);
  assert.match(f.intake.view().requests[0].error, /changed before admission/);
  assert.match(f.repositories.get('shared').files.get(sourcePath), /external author changed/);
});

for (const [label, rule] of [
  ['unknown test evidence', { id: 'independent-tests', fact: 'tests.passed', op: 'eq', value: true }],
  ['failed completion rule', { id: 'two-changes', fact: 'output.changedFileCount', op: 'gte', value: 2 }],
]) test(`${label} never publishes a feature branch or review note`, async t => {
  const f = await fixture(t, { doneRules: [rule] }); await f.intake.sync(); await f.complete(); await f.intake.sync();
  const row = f.intake.view().requests[0]; assert.equal(row.done.passed, false); assert.ok(row.done.issues.length);
  assert.equal(f.patchAttempts.length, 0); assert.equal(row.reviewNote, null); assert.equal(row.featureBranch, null);
  await f.restart(); await f.intake.sync(); assert.equal(f.patchAttempts.length, 0); assert.equal(f.primaryExecutions, 1);
});

test('completion publication requires exact phase, input, policy, output, turn and run evidence', async t => {
  const f = await fixture(t); await f.intake.sync(); await f.complete();
  const mutations = [
    value => { value.request.phase = 'review'; },
    value => { value.request.execution.status = 'running'; },
    value => { value.request.execution.inputRevision++; },
    value => { value.request.policyDigest = 'b'.repeat(64); },
    value => { value.currentTurnId = 'other-turn'; },
    value => { value.runId = 'other-run'; },
    value => { value.patch = null; },
    value => { value.request.evaluations.at(-1).passed = false; },
    value => { value.request.evaluations.at(-1).inputHash = 'b'.repeat(64); },
    value => { value.request.evaluations.at(-1).policyDigest = 'b'.repeat(64); },
    value => { value.request.evaluations.at(-1).outputDigest = 'b'.repeat(64); },
  ];
  for (const mutate of mutations) {
    f.controls.inspect = value => { const copy = structuredClone(value); mutate(copy); return copy; };
    await f.intake.sync(); assert.equal(f.patchAttempts.length, 0);
  }
  f.controls.inspect = null; await f.intake.sync(); assert.equal(f.featureCommits, 1);
});

test('corrupt current policy blocks new claims while a frozen completed request still publishes its valid evidence', async t => {
  const f = await fixture(t); await f.intake.sync(); await f.complete();
  const frozen = (await f.state()).records[0].workflow;
  f.commitFiles('shared', { 'fr-done-check.json': '{invalid current policy', 'features/new.md': source.replace('shared-navigation', 'new-feature') });
  await f.restart(); await f.intake.sync();
  assert.equal(f.featureCommits, 1); assert.equal(f.tasks.size, 1);
  const row = f.intake.view().requests.find(item => item.isLocal); assert.equal(row.status, 'ready_for_review');
  const note = await f.intake.note(row.id); assert.match(note.markdown, new RegExp(frozen.policyDigest));
  assert.equal(f.intake.view().state, 'error'); assert.match(f.intake.view().error, /JSON/);
});

test('lost feature publication acknowledgment retries the same publication after restart without re-execution', async t => {
  const f = await fixture(t); await f.intake.sync(); await f.complete(); f.controls.patchAckBlocked = true;
  await f.intake.sync(); assert.equal(f.featureCommits, 1); assert.equal(f.intake.view().requests[0].publication, 'error');
  const operation = f.patchAttempts[0].operationId;
  await f.restart(); f.controls.patchAckBlocked = false; await f.intake.sync();
  assert.equal(f.featureCommits, 1); assert.equal(f.primaryExecutions, 1); assert.ok(f.patchAttempts.every(write => write.operationId === operation));
  const row = f.intake.view().requests[0]; assert.equal(row.status, 'ready_for_review'); assert.equal(row.publication, 'synced');
  const note = await f.intake.note(row.id); assert.match(note.markdown, /\[\[\.\.\/features\/navigation\]\]/);
  assert.match(note.markdown, /Original source commit/); assert.match(note.markdown, /human review/i);
});

test('lost review-note acknowledgment replays the exact outbox without recreating an already published artifact', async t => {
  const f = await fixture(t); await f.intake.sync(); await f.complete(); f.controls.claimAckBlocked = true;
  await f.intake.sync();
  const pending = (await f.state()).records[0].pending; assert.equal(pending.artifacts.length, 1);
  const notePath = pending.artifacts[0].path, operation = pending.operationId;
  assert.ok(f.repositories.get('shared').files.has(notePath)); assert.equal(f.featureCommits, 1);
  await f.restart(); f.controls.claimAckBlocked = false; await f.intake.sync(); await f.intake.sync();
  assert.equal(f.primaryExecutions, 1); assert.equal(f.featureCommits, 1);
  const noteWrites = f.lifecycleAttempts.filter(write => write.artifacts.some(artifact => artifact.path === notePath));
  assert.ok(noteWrites.length >= 2); assert.ok(noteWrites.every(write => write.operationId === operation));
  assert.equal(f.intake.view().requests[0].publication, 'synced');
});

test('missing owned task history blocks recovery instead of silently readmitting paid work', async t => {
  const f = await fixture(t); await f.intake.sync(); assert.equal(f.submits.length, 1); f.tasks.clear();
  await f.restart(); await f.intake.sync(); await f.intake.sync();
  assert.equal(f.submits.length, 1); assert.equal(f.patchAttempts.length, 0);
  assert.equal(f.intake.view().requests[0].status, 'blocked'); assert.match(f.intake.view().requests[0].error, /history is unavailable/);
});

test('disabling new claims keeps reconciling owned tasks and their publications', async t => {
  const f = await fixture(t); await f.intake.sync();
  await f.intake.configure({ ...f.config, enabled: false }, f.intake.view().revision);
  f.commitFiles('shared', { 'features/new.md': source.replace('shared-navigation', 'new-feature') });
  await f.complete(); await f.restart(); await f.intake.sync();
  assert.equal(f.intake.view().state, 'disabled'); assert.equal(f.tasks.size, 1); assert.equal(f.featureCommits, 1);
  assert.equal(f.intake.view().requests[0].publication, 'synced'); assert.equal(f.intake.view().requests[0].status, 'ready_for_review');
});

test('stable feature IDs deduplicate within a binding and can be used independently after a completed binding change', async t => {
  const f = await fixture(t); await f.intake.sync(); await f.complete(); await f.intake.sync();
  f.addRepository('second'); await f.intake.configure({ ...f.config, repositoryId: 'second' }, f.intake.view().revision);
  await f.intake.sync(); assert.equal(f.tasks.size, 2); assert.equal(new Set(f.submits).size, 2);
  const state = await f.state(); assert.equal(state.records.length, 2); assert.equal(state.records[0].id, state.records[1].id);
  assert.notEqual(bindingKey(state.records[0].binding), bindingKey(state.records[1].binding));
  await f.restart(); await f.intake.sync(); assert.equal(f.tasks.size, 2);
});

test('configuration enforces revision, active binding and in-flight synchronization guards and rolls back failed persistence', async t => {
  const f = await fixture(t), revision = f.intake.view().revision;
  await assert.rejects(f.intake.configure(f.config, revision - 1), /changed.*Reload/);
  const gate = f.blockNextHead(), sync = f.intake.sync(); await gate.entered;
  await assert.rejects(f.intake.configure(f.config, revision), /synchronization/); gate.release(); await sync;
  f.addRepository('second'); await assert.rejects(f.intake.configure({ ...f.config, repositoryId: 'second' }, revision), /Finish.*owned/);
  f.controls.saveBlocked = true;
  await assert.rejects(f.intake.configure({ ...f.config, enabled: false }, revision), /state write failure/);
  assert.equal(f.intake.view().revision, revision); assert.equal(f.intake.enabled, true);
  f.controls.saveBlocked = false;
  const changed = await Promise.allSettled([f.intake.configure({ ...f.config, enabled: false }, revision), f.intake.configure({ ...f.config, pollMs: 2000 }, revision)]);
  assert.equal(changed.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(changed.filter(result => result.status === 'rejected').length, 1);
});

test('malformed persisted ownership, source hashes, frozen policy and outbox fail closed', async t => {
  const f = await fixture(t); f.controls.claimAckBlocked = true; await f.intake.sync();
  const original = await f.state(), path = join(f.directory, 'shared-intake.json');
  const mutations = [
    state => { state.workerId = '../other'; },
    state => { state.records.push(structuredClone(state.records[0])); },
    state => { state.records[0].owner = 'another-worker'; },
    state => { state.records[0].submitted = true; },
    state => { const record = state.records[0]; record.sourceCommit = 'a'.repeat(41); record.workflow.commit = record.sourceCommit; const readiness = validateFeatureReadiness(record.sourceMarkdown, record.workflow.readyCheck, undefined, record.workflow.template); record.inputHash = sharedHash(readiness.inputHash + record.workflow.policyDigest + record.sourceCommit + sharedHash(record.sourceMarkdown)); },
    state => { state.records[0].accepted.criteria = ['Changed criterion']; },
    state => { state.records[0].workflow.policy.done.patch = []; },
    state => { state.records[0].workflow.template += 'modified'; },
    state => { state.records[0].inputHash = 'b'.repeat(64); },
    state => { state.records[0].featureCommit = 'not-a-git-commit'; },
    state => { state.records[0].outputDigest = 'not-a-digest'; },
    state => { state.records[0].pending.request.path = '../outside.md'; },
    state => { state.records[0].pending.request.expectedRevision = 'b'.repeat(64); },
    state => { state.records[0].pending.artifacts = [{ path: '../outside.md', expectedRevision: null, content: 'outside' }]; },
  ];
  for (const [index, mutate] of mutations.entries()) { const damaged = structuredClone(original); mutate(damaged); await writeFile(path, JSON.stringify(damaged)); await assert.rejects(new SharedFeatureJournal(f.directory).load(), 'Malformed saved variant ' + index + ' must be rejected.'); }
  await writeFile(path, '{truncated'); await assert.rejects(new SharedFeatureJournal(f.directory).load());
  await writeFile(path, JSON.stringify(original)); assert.equal((await new SharedFeatureJournal(f.directory).load()).records.length, 1);
  assert.equal(f.tasks.size, 0); assert.equal(f.primaryExecutions, 0);
});


test('identical feature output on another intake branch gets distinct feature and review publications', async t => {
  const f = await fixture(t); await f.intake.sync(); await f.complete(); await f.intake.sync();
  const first = (await f.state()).records[0], originalNote = f.repositories.get('shared').files.get(first.reviewNote);
  // A new branch may retain earlier review notes but introduce this ID as ready.
  f.commitFiles('shared', { [sourcePath]: source });
  await f.intake.configure({ ...f.config, branch: 'next-intake' }, f.intake.view().revision);
  await f.intake.sync(); const secondTask = [...f.tasks.keys()].at(-1);
  assert.notEqual(secondTask, first.taskId); await f.complete(secondTask); await f.intake.sync();
  const second = (await f.state()).records[1];
  assert.equal(first.id, second.id); assert.equal(first.outputDigest, second.outputDigest);
  assert.notEqual(first.sourceCommit, second.sourceCommit); assert.notEqual(first.reviewNote, second.reviewNote);
  assert.notEqual(f.patchAttempts[0].operationId, f.patchAttempts.at(-1).operationId);
  assert.equal(f.featureCommits, 2); assert.equal(second.status, 'ready_for_review'); assert.equal(second.publication, 'synced');
  assert.equal(f.repositories.get('shared').files.get(first.reviewNote), originalNote);
  assert.ok(f.repositories.get('shared').files.has(second.reviewNote));
  const attempts = f.patchAttempts.length; await f.restart(); await f.intake.sync();
  assert.equal(f.patchAttempts.length, attempts); assert.equal(f.primaryExecutions, 2);
});

for (const status of ['ready_for_review', 'failed', 'cancelled']) test('a published ' + status + ' request survives removed assignments and local history', async t => {
  const f = await fixture(t); await f.intake.sync();
  if (status === 'ready_for_review') await f.complete();
  else f.controls.inspect = value => ({ ...value, status, error: 'Fixture terminal outcome', request: { ...value.request, phase: status } });
  await f.intake.sync(); assert.equal(f.intake.view().requests[0].status, status);
  await f.intake.configure({ ...f.config, enabled: false }, f.intake.view().revision);
  f.repositories.delete('shared'); await f.restart(); await f.intake.sync();
  assert.equal(f.intake.view().requests[0].publication, 'synced'); assert.equal(f.intake.view().requests[0].status, status);
  assert.equal(f.intake.view().error, null);
  f.tasks.clear(); await f.intake.sync();
  assert.equal(f.intake.view().requests[0].publication, 'synced'); assert.equal(f.intake.view().requests[0].status, status);
});

test('resuming a published terminal task still publishes its changed lifecycle', async t => {
  const f = await fixture(t); await f.intake.sync(); let phase = 'failed';
  f.controls.inspect = value => ({ ...value, status: phase, error: phase === 'failed' ? 'Fixture failure' : null, request: { ...value.request, phase } });
  await f.intake.sync(); assert.equal(f.intake.view().requests[0].status, 'failed');
  const before = f.lifecycleAttempts.length; phase = 'running'; await f.intake.sync();
  assert.equal(f.intake.view().requests[0].status, 'running'); assert.equal(f.intake.view().requests[0].publication, 'synced');
  assert.ok(f.lifecycleAttempts.length > before);
});

test('one unavailable repository adapter does not prevent later owned publications', async t => {
  const f = await fixture(t); await f.intake.sync();
  f.commitFiles('shared', { 'features/second.md': source.replace('shared-navigation', 'shared-second') });
  await f.intake.sync(); assert.equal(f.tasks.size, 2);
  await f.intake.configure({ ...f.config, enabled: false }, f.intake.view().revision);
  await f.complete([...f.tasks.keys()].at(-1)); f.controls.repositoryFailures = 1;
  await f.intake.sync(); const rows = f.intake.view().requests;
  assert.equal(rows[0].publication, 'error'); assert.match(rows[0].error, /repository unavailable/);
  assert.equal(rows[1].status, 'ready_for_review'); assert.equal(rows[1].publication, 'synced'); assert.equal(f.featureCommits, 1);
});

test('a committed definitionRef is retained in the accepted input that admission hands to the task board', async t => {
  const f = await fixture(t, { source: source.replace('mode: patch\n', 'mode: patch\ndefinitionRef: team-reviewer\nagent: root\n') });
  await f.intake.sync(); assert.equal(f.tasks.size, 1);
  const [record] = (await f.state()).records;
  assert.equal(record.accepted.definitionRef, 'team-reviewer'); assert.equal(record.accepted.agent, 'root'); assert.equal(record.accepted.definitionId, undefined);
});

test('a worker without the referenced instruction profile leaves the request unclaimed until it can run it', async t => {
  const f = await fixture(t, { source: source.replace('mode: patch\n', 'mode: patch\ndefinitionRef: team-reviewer\n') });
  f.controls.admissionIssue = input => input.definitionRef === 'team-reviewer' ? 'No agent definition on this worker uses the reference team-reviewer.' : undefined;
  await f.intake.sync();
  assert.equal(f.tasks.size, 0); assert.equal(f.lifecycleAttempts.length, 0, 'no remote claim is written');
  const [view] = f.intake.view().requests; assert.equal(view.owner, null); assert.equal(view.status, 'ready'); assert.match(view.error, /team-reviewer/);
  f.controls.admissionIssue = undefined; await f.intake.sync();
  assert.equal(f.tasks.size, 1); assert.equal((await f.state()).records[0].accepted.definitionRef, 'team-reviewer');
});
