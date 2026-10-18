import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bindingKey } from '../../src/worker/dist/worker/application/shared-feature-state.js';
import { sharedHash } from '../../src/worker/dist/worker/application/shared-feature-notes.js';
import { SharedFeatureJournal } from '../../src/worker/dist/worker/infrastructure/journal/shared-features.js';
import { validateFeatureReadiness } from '../../src/worker/dist/worker/infrastructure/features/workflow.js';
import { fixture, source, sourcePath } from './shared-feature-fixture.mjs';

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
  const record = (await f.state()).records[0];
  assert.ok(note.markdown.includes('Implementation source commit: `' + record.sourceCommit + '`'));
  assert.ok(note.markdown.includes('Workflow source commit: `' + record.workflow.commit + '`'));
  assert.match(note.markdown, /human review/i);
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
  assert.equal(f.tasks.size, 0); assert.equal((await f.state()).records.length, 0, 'diagnostics do not reserve execution');
  assert.ok(f.lifecycleAttempts.every(write => write.request.content === source.replace('mode: patch\n', 'mode: patch\ndefinitionRef: team-reviewer\n')), 'diagnostic publication leaves the request unchanged');
  const diagnostic = f.intake.view().requests[0].taskNote;
  assert.match(f.repositories.get('shared').files.get(diagnostic), /status: blocked/);
  const [view] = f.intake.view().requests; assert.equal(view.owner, null); assert.equal(view.status, 'ready'); assert.match(view.error, /team-reviewer/);
  f.controls.admissionIssue = undefined; await f.intake.sync();
  assert.equal(f.tasks.size, 1); assert.equal((await f.state()).records[0].accepted.definitionRef, 'team-reviewer');
  assert.match(f.repositories.get('shared').files.get(diagnostic), /status: resolved/);
});

test('a profile becoming unavailable after claim does not abandon or duplicate an owned request', async t => {
  const f = await fixture(t, { source: source.replace('mode: patch\n', 'mode: patch\ndefinitionRef: team-reviewer\n') });
  await f.intake.sync();
  const [accepted] = (await f.state()).records;
  assert.equal(accepted.claimed, true); assert.equal(accepted.submitted, true);
  const claims = f.lifecycleAttempts.length;
  f.controls.admissionIssue = () => 'No agent definition on this worker uses the reference team-reviewer.';
  await f.intake.sync();
  const [retained] = (await f.state()).records;
  assert.equal(retained.owner, accepted.owner); assert.equal(retained.taskId, accepted.taskId);
  assert.equal(retained.accepted.definitionRef, 'team-reviewer'); assert.equal(retained.claimed, true);
  assert.equal(f.tasks.size, 1); assert.equal(f.lifecycleAttempts.length, claims);
});

test('readiness diagnostics publish without claiming and resolve once the committed request is corrected', async t => {
  const invalid = source.replace('- Arrow keys move the active selection.', '- TODO');
  const f = await fixture(t, { source: invalid });
  await f.intake.sync();
  const view = f.intake.view().requests[0];
  assert.equal(view.status, 'needs_rework'); assert.equal(view.owner, null);
  const diagnostic = view.taskNote, repo = f.repositories.get('shared');
  assert.match(repo.files.get(diagnostic), /type: Task/);
  assert.match(repo.files.get(diagnostic), /status: blocked/);
  assert.equal(repo.files.get(sourcePath), invalid);
  assert.equal(f.primaryExecutions, 0); assert.equal((await f.state()).records.length, 0);
  const writes = f.lifecycleAttempts.length;
  await f.restart(); await f.intake.sync();
  assert.equal(f.lifecycleAttempts.length, writes, 'unchanged diagnostics do not churn commits');
  f.commitFiles('shared', { [sourcePath]: source });
  await f.intake.sync();
  assert.equal(f.tasks.size, 1); assert.match(repo.files.get(diagnostic), /status: resolved/);
});
test('editing a diagnostic never executes input or silently overwrites the teammate change', async t => {
  const invalid = source.replace('- Arrow keys move the active selection.', '- TODO');
  const f = await fixture(t, { source: invalid }); await f.intake.sync();
  const path = f.intake.view().requests[0].taskNote;
  const edited = f.repositories.get('shared').files.get(path) + '\nHuman investigation notes.\n';
  f.commitFiles('shared', { [path]: edited }); await f.intake.sync();
  assert.equal(f.primaryExecutions, 0); assert.equal(f.tasks.size, 0);
  assert.equal(f.repositories.get('shared').files.get(path), edited);
  assert.match(f.intake.view().error, /intake Task was edited/);
  f.commitFiles('shared', { 'features/other.md': source.replace('shared-navigation', 'other-feature') });
  await f.intake.sync();
  assert.equal(f.tasks.size, 1, 'a diagnostic conflict does not starve another request');
  assert.equal(f.repositories.get('shared').files.get(path), edited);
});


test('webview Task publication survives the actual journal and rejects a changed saved answer', async t => {
  const f = await fixture(t); await f.intake.sync();
  const at = '2026-10-17T00:00:00.000Z', record = (await f.state()).records[0];
  f.controls.inspect = execution => ({ ...execution, status: 'waiting_input', interaction: {
    schemaVersion: 1, sessionId: 'local-' + record.taskId, revision: 2, phase: 'waiting_input',
    pending: { id: 'question-one', kind: 'question', message: 'Which timezone?', createdAt: at, turnId: 'turn-one' },
    latestTurn: { id: 'turn-one', runId: null, kind: 'message', status: 'waiting_input', createdAt: at, finishedAt: at, priorTurnId: null }, turns: [], totalTurns: 1,
  } });
  await f.intake.sync();
  await f.intake.respond(record.taskId, { action: 'answer', sessionId: 'local-' + record.taskId, expectedRevision: 2, pendingId: 'question-one', operationId: 'ui-publication-one', answer: 'Use UTC dates.' });
  const saved = await f.state();
  assert.equal(saved.records[0].task.uiResponse.command.answer, 'Use UTC dates.');
  assert.match(saved.records[0].task.uiResponse.markdown, /status: ready/);
  await f.restart(); assert.equal(f.intake.view().requests.length, 1);
  const path = join(f.directory, 'shared-intake.json');
  const changed = structuredClone(saved); changed.records[0].task.uiResponse.command.answer = 'Use local dates.';
  await writeFile(path, JSON.stringify(changed));
  await assert.rejects(new SharedFeatureJournal(f.directory).load(), /UI response reservation/);
  await writeFile(path, JSON.stringify(saved));
});
