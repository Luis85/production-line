import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedFeatureIntake } from '../../src/worker/dist/worker/application/shared-feature-intake.js';
import { sharedHash } from '../../src/worker/dist/worker/application/shared-feature-notes.js';
import { SharedFeatureJournal } from '../../src/worker/dist/worker/infrastructure/journal/shared-features.js';
import { WorkerRequestJournal } from '../../src/worker/dist/worker/infrastructure/journal/requests.js';
import { defaultFeatureWorkflow, defaultFeatureCheck, featureGateInput } from '../../src/worker/dist/worker/application/feature-workflow.js';
import { validateFeatureReadiness, loadFeatureWorkflowSnapshot } from '../../src/worker/dist/worker/infrastructure/features/workflow.js';
import { validateFeatureReviewEligibility } from '../../src/worker/dist/worker/infrastructure/features/review-eligibility.js';
import { readReadyReviewResponse, writeReadyReviewAnswer } from '../../src/worker/dist/worker/infrastructure/features/ready-review-document.js';
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
export const source = `---
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
export const sourcePath = 'features/navigation.md';
const patch = 'diff --git a/src/navigation.ts b/src/navigation.ts\n--- a/src/navigation.ts\n+++ b/src/navigation.ts\n@@ -1 +1 @@\n-before\n+after\n';

export async function fixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-shared-coordinator-')));
  const controls = { claimAckBlocked: false, submitAckBlocked: false, patchAckBlocked: false, changeAfterClaim: false, saveBlocked: false, answerSaveAckBlocked: false, admit: true, inspect: null, repositoryFailures: 0 };
  const events = [], repositories = new Map(), tasks = new Map();
  const lifecycleAttempts = [], patchAttempts = [], submits = [], submittedRecords = [];
  let counter = 0, primaryExecutions = 0, featureCommits = 0, journal, requests, headGate, diagnosticGate, reviewSaveGate, reviewConflictGate;
  /** @type {SharedFeatureIntake} */
  let intake;
  const nextCommit = () => (++counter).toString(16).padStart(40, '0');
  function addRepository(id = 'shared', content = source) {
    const configuration = defaultFeatureWorkflow(), done = defaultFeatureCheck('done');
    done.rules.patch = options.doneRules ?? [];
    if (options.readyReview) configuration.readyReviewPrompt = 'prompts/ready-review.md';
    const files = new Map(Object.entries({ '.werk/feature-workflow.json': JSON.stringify(configuration), [configuration.readyCheck]: JSON.stringify(defaultFeatureCheck('ready')), [configuration.doneCheck]: JSON.stringify(done), [configuration.template]: template, [configuration.base]: 'views:\n  - type: table\n    name: Features\n', [sourcePath]: content }));
    if (options.readyReview) files.set(configuration.readyReviewPrompt, 'Challenge ambiguous goals and ask the team for missing details.');
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
      async readBlob(commit, path) { if (diagnosticGate && /\/intake-/.test(path)) { const gate = diagnosticGate; diagnosticGate = undefined; gate.enter(); await gate.wait; } assert.ok(repo.versions.has(commit), 'Reads must use a known immutable commit.'); return repo.versions.get(commit).get(path) ?? null; },
      async listRequests(commit) { return [...repo.versions.get(commit)].filter(([path]) => /^features\/[^/_][^/]*\.md$/.test(path)).map(([path, content]) => ({ path, name: path.slice('features/'.length), content, revision: sharedHash(content) })); },
      async publishLifecycle(write) {
        await controls.beforeLifecycle?.(write);
        lifecycleAttempts.push(structuredClone(write)); events.push('lifecycle-attempt');
        let result = repo.lifecycle.get(write.operationId);
        if (!result) {
          if (sharedHash(repo.files.get(write.request.path)) !== write.request.expectedRevision) throw Object.assign(Error('Lifecycle writes use compare-and-swap.'), { code: 'conflict' });
          const edits = { [write.request.path]: write.request.content };
          for (const artifact of write.artifacts) { assert.equal(repo.files.has(artifact.path) ? sharedHash(repo.files.get(artifact.path)) : null, artifact.expectedRevision); edits[artifact.path] = artifact.content; }
          const commit = commitFiles(binding.repositoryId, edits); result = { commit, head: commit }; repo.lifecycle.set(write.operationId, result);
          if (controls.changeAfterClaim) { controls.changeAfterClaim = false; commitFiles(binding.repositoryId, { [write.request.path]: write.request.content + '\nAn external author changed this claimed request.\n' }); }
        }
        if (controls.claimAckBlocked) throw Error('Fixture lost claim acknowledgment');
        events.push('lifecycle-confirmed'); return result;
      },
      async publishReadyReviewAnswer(write) { return this.publishLifecycle(write); },
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
    async save(state) {
      if (controls.saveBlocked) throw Error('Fixture state write failure');
      await journal.save(state);
      if (controls.answerSaveAckBlocked && state.records.some(record => record.readyReviewAnswers?.some(item => item.status === 'pending'))) throw Error('Fixture lost answer intent save acknowledgement');
      if (reviewConflictGate && state.records.some(record => record.readyReviewState?.status === 'passed' && !record.readyReviewState.implementationReady && record.claimed && !record.pending)) {
        const gate = reviewConflictGate; reviewConflictGate = undefined; gate.enter(); await gate.wait;
      }
      if (reviewSaveGate && state.records.some(record => record.status === 'ready_for_review' && record.reviewNote && !record.pending && !record.publishedReview)) {
        const gate = reviewSaveGate; reviewSaveGate = undefined; gate.enter(); await gate.wait;
      }
    },
    repository,
    loadWorkflow: (repo, commit, configPath) => loadFeatureWorkflowSnapshot({ commit, configPath, readBlob: (at, path) => repo.readBlob(at, path) }),
    readyReview: options.readyReview, resolveSelection: options.resolveSelection, prepare: options.prepare,
    readyReviewEligible: (markdown, snapshot, provider) => validateFeatureReviewEligibility(markdown, snapshot, provider ?? options.defaultProvider?.()),
    readyReviewResponse: readReadyReviewResponse, readyReviewAnswer: writeReadyReviewAnswer,
    ready: (markdown, snapshot, provider) => { options.onReady?.(); return validateFeatureReadiness(markdown, snapshot.readyCheck, provider ?? options.defaultProvider?.(), snapshot.template); },
    source: sharedSource,
    renderSource: renderSharedSource,
    async submit(record) {
      assert.equal(record.claimed, true, 'Dispatch needs a remotely confirmed claim.'); assert.equal(record.pending, undefined);
      if (!tasks.has(record.taskId)) assert.equal(events.at(-1), 'lifecycle-confirmed', 'Claim acknowledgment precedes initial submission.');
      submits.push(record.taskId); submittedRecords.push(structuredClone(record)); events.push('submit');
      if (!tasks.has(record.taskId)) {
        const request = requests.ensure({ owner: { sessionId: 'local-' + record.taskId, rootTurnId: record.taskId, taskId: record.taskId }, input: featureGateInput(record.accepted), provider: { id: 'fixture', model: 'fixture-only', instruction: 'No external calls' }, policy: record.workflow.policy });
        tasks.set(record.taskId, { status: 'queued', requestId: request.id, summary: null, patch: null, currentTurnId: 'turn-' + record.taskId, runId: 'run-' + record.taskId });
      }
      if (controls.submitAckBlocked) throw Error('Fixture lost task admission acknowledgment');
    },
    inspect(id) { const task = tasks.get(id); if (!task) return undefined; const execution = { ...task, request: requests.get(task.requestId) }; return controls.inspect ? controls.inspect(execution) : execution; },
    canAdmit: () => controls.admit && !controls.admissionHold?.(),
    admissionHold: () => controls.admissionHold?.(),
    admissionIssue: input => controls.admissionIssue?.(input),
  };
  async function open() { journal = new SharedFeatureJournal(directory); requests = new WorkerRequestJournal(directory); await requests.init(); intake = new SharedFeatureIntake(ports); await intake.init(); }
  await open();
  assert.ok(intake);
  const config = { enabled: true, repositoryId: 'shared', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 1000 };
  await intake.configure(config, 0);
  t.after(async () => { await intake.close(); requests.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory, config, controls, ports, events, repositories, tasks, lifecycleAttempts, patchAttempts, submits, submittedRecords, addRepository, commitFiles,
    get intake() { return intake; }, get requests() { return requests; }, get primaryExecutions() { return primaryExecutions; }, get featureCommits() { return featureCommits; },
    async state() { return JSON.parse(await readFile(join(directory, 'shared-intake.json'), 'utf8')); },
    async restart() { await intake.close(); requests.close(); await open(); },
    async complete(id = [...tasks.keys()][0]) {
      const task = tasks.get(id), request = requests.get(task.requestId); assert.equal(task.status, 'queued'); primaryExecutions++;
      requests.evaluate(request.id, 'ready'); requests.bindTurn(request.id, task.currentTurnId); requests.prepareExecution(request.id, task.currentTurnId, task.runId); requests.startExecution(request.id, task.currentTurnId, task.runId);
      requests.recordResult(request.id, task.currentTurnId, task.runId, { type: 'completed', text: JSON.stringify({ summary: 'Fixture change; tests are not independently verified.', files: [{ path: 'src/navigation.ts', content: 'after\n' }] }) }, { 'output.protocolValid': true, 'output.patchPresent': true, 'output.changedFileCount': 1 });
      Object.assign(task, { status: 'review', patch, summary: 'Fixture proposed navigation change.' });
    },
    blockNextReadyReviewConflictSave() { const entered = Promise.withResolvers(), wait = Promise.withResolvers(); reviewConflictGate = { enter: () => entered.resolve(undefined), wait: wait.promise }; return { entered: entered.promise, release: () => wait.resolve(undefined) }; },
    blockNextReviewSave() { const entered = Promise.withResolvers(), wait = Promise.withResolvers(); reviewSaveGate = { enter: () => entered.resolve(undefined), wait: wait.promise }; return { entered: entered.promise, release: () => wait.resolve(undefined) }; },
    blockNextDiagnosticRead() { const entered = Promise.withResolvers(), wait = Promise.withResolvers(); diagnosticGate = { enter: () => entered.resolve(undefined), wait: wait.promise }; return { entered: entered.promise, release: () => wait.resolve(undefined) }; },
    blockNextHead() { const entered = Promise.withResolvers(), wait = Promise.withResolvers(); headGate = { enter: () => entered.resolve(undefined), wait: wait.promise }; return { entered: entered.promise, release: () => wait.resolve(undefined) }; },
  };
}

