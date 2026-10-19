import { testErrorCode } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { WorkerSessions } from './application-fixtures.mjs';
import { LocalTaskboard } from './application-fixtures.mjs';
import { defaultGatePolicy, gateDigest } from '../../src/worker/dist/worker/application/request-gates.js';
import { featureContentHash } from '../../src/worker/dist/worker/application/feature-workflow.js';
import { submissionContextHash } from '../../src/worker/dist/worker/application/local-task-contracts.js';
import { originalPrompt } from '../../src/worker/dist/worker/application/local-task-preparation.js';
import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';

const execute = promisify(execFile);
const git = async (directory, ...args) => (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args])).stdout.trim();
async function fixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-shared-admission-')));
  const repository = join(directory, 'repository'), state = join(directory, 'state');
  await mkdir(repository); await mkdir(state);
  await git(repository, 'init', '--initial-branch=main');
  await git(repository, 'config', 'core.autocrlf', 'false');
  await git(repository, 'config', 'core.eol', 'lf');
  await git(repository, 'config', 'user.name', 'Shared admission fixture');
  await git(repository, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repository, 'approved.txt'), 'frozen source\n');
  await git(repository, 'add', 'approved.txt');
  await git(repository, 'commit', '-m', 'Frozen intake source');
  const baseCommit = await git(repository, 'rev-parse', 'HEAD');
  await writeFile(join(repository, 'approved.txt'), 'later source\n');
  await git(repository, 'commit', '-am', 'Advance source checkout');
  const headCommit = await git(repository, 'rev-parse', 'HEAD');
  const settings = new WorkerSettings(state); await settings.init();
  await settings.update({ provider: { id: 'openai-api', model: 'fixture', apiKey: 'fixture-only' }, repositories: { pollMs: 30000, items: [{ id: 'shared', path: repository, remote: 'origin', watch: false }] } });
  const calls = [], preparations = [];
  /** @type {import('../../src/worker/infrastructure/workspace-services.js').WorkspaceProviderFactory} */
  const factory = connection => ({
    configuration: { id: connection.id, model: connection.model, instruction: 'Fixture only; no external calls' },
    capabilities: modelCapabilities,
    async execute(request) { calls.push(request); if (options.question && calls.length === 1) return { type: 'needs_input', request: { schemaVersion: 1, kind: 'question', message: 'Which expected behavior?' } }; return { type: 'completed', text: JSON.stringify({ summary: 'Fixture patch; tests not run.', files: [{ path: 'approved.txt', content: 'proposed change\n' }] }) }; },
    async reply() { throw Error('Structured fixture required'); },
  });
  const port = options.noPort ? undefined : { async prepareWorktree(selector, taskKey, signal, pinned) {
    preparations.push({ selector, taskKey, pinned }); signal.throwIfAborted();
    // Match the adapter's bounded basename while retaining the complete ownership key above.
    const name = 'shared-' + createHash('sha256').update(taskKey).digest('hex').slice(0, 32);
    const path = join(repository, '.werk', 'worktrees', name), base = pinned ?? headCommit;
    await git(repository, 'worktree', 'add', '--detach', path, base);
    return { repositoryId: 'shared', repository, path, baseCommit: options.wrongCommit ? headCommit : base };
  } };
  let sessions, board;
  async function open() {
    sessions = WorkerSessions(state, settings, factory); await sessions.init();
    board = LocalTaskboard(state, settings, sessions, factory, port); await board.init();
  }
  await open();
  t.after(async () => { await board.close(); await sessions.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    state, repository, baseCommit, headCommit, settings, calls, preparations,
    get board() { return board; }, get sessions() { return sessions; },
    input: { title: 'Shared feature', instruction: 'Change only the approved file.', repository, paths: ['approved.txt'], provider: 'openai-api' },
    submission(policy = defaultGatePolicy()) { return { id: 'shared-feature-task', hash: 'a'.repeat(64), repositoryId: 'shared', baseCommit, criteria: ['Approved content changes.'], policy }; },
    async restart() { await board.close(); await sessions.close(); await open(); },
    async settle(id, status = 'review') { await board.tick(); for (let i = 0; i < 400; i++) { if (board.detail(id).status === status && !sessions.executor.busy) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error('Task did not produce review output'); },
  };
}
function heldPolicy() {
  const policy = defaultGatePolicy(); policy.id = 'shared-frozen'; policy.reviewer.enabled = false;
  policy.ready.patch.push({ id: 'shared-criteria', fact: 'input.criteriaCount', op: 'gte', value: 1 });
  policy.done.patch.push({ id: 'shared-approval', fact: 'operator.accepted', op: 'eq', value: true });
  return policy;
}

test('trusted shared admission freezes task-local policy, criteria and source commit across execution and restart', async t => {
  const f = await fixture(t), submission = f.submission(heldPolicy()), frozen = structuredClone(submission);
  const initialGlobalPolicy = f.sessions.requests.policy();
  const admission = f.board.create(f.input, submission);
  submission.policy.id = 'caller-mutated'; submission.criteria[0] = 'Caller mutation'; submission.baseCommit = f.headCommit;
  await admission;
  const task = f.board.detail(frozen.id), request = f.sessions.requests.get(task.requestId);
  assert.equal(task.repositoryId, 'shared'); assert.equal(task.baseCommit, f.baseCommit);
  assert.equal(task.files[0].content, 'frozen source\n');
  assert.equal(f.preparations[0].pinned, f.baseCommit);
  assert.deepEqual(task.gatePolicy, frozen.policy); assert.deepEqual(task.criteria, frozen.criteria);
  assert.deepEqual(request.policy, frozen.policy); assert.deepEqual(request.input.criteria, frozen.criteria);
  assert.deepEqual(f.sessions.requests.policy(), initialGlobalPolicy, 'Admission must not change the policy for other tasks.');
  const defaults = defaultGatePolicy(); defaults.id = 'new-worker-default';
  f.sessions.requestPolicy = () => defaults;
  f.sessions.requests.setPolicy({ policy: defaults, expectedRevision: initialGlobalPolicy.revision, operationId: 'change-default' });
  await f.settle(task.id);
  assert.equal(f.sessions.requests.get(task.requestId).phase, 'review', 'A patch alone cannot bypass the frozen completion policy.');
  assert.match(f.calls[0].messages.map(row => row.text).join('\n'), /Acceptance criteria:.*Approved content changes/);
  assert.match(f.board.detail(task.id).patch, /-frozen source\n\+proposed change/);
  assert.equal(await readFile(join(f.repository, 'approved.txt'), 'utf8'), 'later source\n');
  await f.restart(); await f.board.create(f.input, frozen);
  assert.equal(f.calls.length, 1); assert.equal(f.preparations.length, 1);
  const held = f.sessions.requests.get(task.requestId);
  assert.deepEqual(held.policy, frozen.policy); assert.deepEqual(held.input.criteria, frozen.criteria);
  const done = f.sessions.requests.command({ action: 'attest', requestId: held.id, expectedRevision: held.revision, operationId: 'approve-exact-output', inputHash: held.inputHash, outputDigest: held.execution.outputDigest, note: 'Fixture operator reviewed this exact patch.' }).request;
  const evaluation = done.evaluations.findLast(row => row.stage === 'done' && row.inputRevision === done.inputRevision);
  assert.equal(done.phase, 'done'); assert.equal(evaluation.passed, true);
  assert.equal(evaluation.inputHash, done.inputHash); assert.equal(evaluation.policyDigest, gateDigest(frozen.policy));
  assert.equal(evaluation.outputDigest, done.execution.outputDigest); assert.ok(evaluation.outputDigest);
});

test('durable task replay rejects changed trusted policy, criteria, assignment or pinned source even with the same submission hash', async t => {
  const f = await fixture(t), submission = f.submission(heldPolicy());
  await Promise.all([f.board.create(f.input, submission), f.board.create(f.input, submission)]);
  for (const change of [
    { policy: { ...submission.policy, version: 2 } }, { criteria: ['Different acceptance'] },
    { repositoryId: 'other' }, { baseCommit: f.headCommit },
  ]) await assert.rejects(f.board.create(f.input, { ...submission, ...change }), /different input/);
  await assert.rejects(f.board.create(f.input, { id: submission.id, hash: submission.hash }), /different input/);
  assert.equal(f.preparations.length, 1); assert.equal(f.board.view().tasks.length, 1);
});

test('recovery reconstructs a missing task request reference using frozen policy and criteria, never current defaults', async t => {
  const f = await fixture(t), policy = heldPolicy(); policy.ready.patch.at(-1).value = 2;
  const submission = f.submission(policy); await f.board.create(f.input, submission);
  const task = f.board.detail(submission.id); assert.equal(task.status, 'needs_rework');
  const saved = JSON.parse(await readFile(join(f.state, 'taskboard.json'), 'utf8')); delete saved[0].requestId;
  await writeFile(join(f.state, 'taskboard.json'), JSON.stringify(saved));
  const defaultRevision = f.sessions.requests.policy().revision;
  f.sessions.requests.setPolicy({ policy: defaultGatePolicy(), expectedRevision: defaultRevision, operationId: 'relax-current-policy' });
  await f.restart(); await f.board.action({ id: task.id, action: 'cancel' });
  await assert.rejects(f.board.action({ id: task.id, action: 'retry' }), /Readiness/);
  const restored = f.sessions.requests.get(task.requestId);
  assert.deepEqual(restored.policy, policy); assert.deepEqual(restored.input.criteria, submission.criteria);
  assert.equal(restored.execution, null); assert.equal(f.calls.length, 0); assert.equal(f.preparations.length, 1);
});

test('HTTP task input cannot override trusted gates or source and malformed reservations fail before worktree creation', async t => {
  const f = await fixture(t), submission = f.submission();
  for (const [key, value] of Object.entries({ policy: submission.policy, criteria: submission.criteria, repositoryId: 'shared', baseCommit: f.baseCommit }))
    await assert.rejects(f.board.create({ ...f.input, [key]: value }), /unknown field/i);
  for (const change of [{ policy: {} }, { criteria: ['x'.repeat(2001)] }, { criteria: Array(65).fill('Criterion') }, { baseCommit: 'HEAD' }, { repositoryId: '../outside' }])
    await assert.rejects(f.board.create(f.input, { ...submission, ...change }), error => testErrorCode(error) === 'invalid_input');
  await assert.rejects(f.board.create(f.input, { ...submission, repositoryId: 'other' }), /reserved assignment/);
  assert.equal(f.preparations.length, 0); assert.equal(f.board.view().tasks.length, 0);
});

test('pinned admission refuses an adapter returning another source commit or no worktree service', async t => {
  const wrong = await fixture(t, { wrongCommit: true });
  await assert.rejects(wrong.board.create(wrong.input, wrong.submission()), /reserved source commit/);
  assert.equal(wrong.board.view().tasks.length, 0); assert.equal(wrong.calls.length, 0);
  const missing = await fixture(t, { noPort: true });
  await missing.settings.update({ repositories: { pollMs: 30000, items: [] } });
  const submission = missing.submission(); delete submission.repositoryId;
  await assert.rejects(missing.board.create(missing.input, submission), /worktree service/);
  assert.equal(missing.board.view().tasks.length, 0);
});


/** @returns {import('../../src/worker/application/feature-workflow.ts').FeatureDefinitionPrompts & Required<Pick<import('../../src/worker/application/feature-workflow.ts').FeatureDefinitionPrompts, 'ready' | 'done'>>} */
function definitionPrompts(commit) {
  const ready = 'Confirm the migration target with the team before implementation.', done = 'Report the migration regression evidence and remaining limitations.';
  return { schemaVersion: 1, commit,
    ready: { path: 'team/definition-of-ready.md', content: ready, sha256: featureContentHash(ready) },
    done: { path: 'team/definition-of-done.txt', content: done, sha256: featureContentHash(done) },
  };
}

function dispatchedDefinition(prompt, stage) {
  const lines = prompt.split('\n'), heading = lines.findIndex(line => line.startsWith('Definition of ' + stage + ' —'));
  assert.notEqual(heading, -1, 'Dispatch must label the team definition.');
  return JSON.parse(lines[heading + 1]);
}

test('definition prompts stay frozen through queued restart, questions, answers and trusted replay', async t => {
  const f = await fixture(t, { question: true });
  const submission = { ...f.submission(), definitionPrompts: definitionPrompts(f.baseCommit) }, frozen = structuredClone(submission);
  const admission = f.board.create(f.input, submission);
  submission.definitionPrompts.ready.content = 'A later team definition must not replace the accepted prompt.';
  submission.definitionPrompts.done.path = 'team/later-done.md';
  await admission;
  let task = f.board.executionDetail(frozen.id);
  assert.deepEqual(task.definitionPrompts, frozen.definitionPrompts);
  const request = f.sessions.requests.get(task.requestId);
  const context = request.input.context;
  assert.ok(context && typeof context === 'object' && 'definitionPrompts' in context);
  assert.deepEqual(context.definitionPrompts, frozen.definitionPrompts);
  assert.equal(request.input.message, f.input.instruction, 'Definitions do not alter the authored request or its readiness length.');
  assert.doesNotMatch(JSON.stringify(f.board.detail(task.id)), /Confirm the migration target|Report the migration regression/);
  const accepted = f.sessions.interactions.turn(task.sessionId, task.currentTurnId).dispatch;
  const firstMessage = accepted.messages[0].text;
  assert.match(firstMessage, /Definition of Ready.*check prerequisites/);
  assert.match(firstMessage, /Definition of Done.*verify the outcome/);
  assert.deepEqual(dispatchedDefinition(firstMessage, 'Ready'), frozen.definitionPrompts.ready);
  assert.deepEqual(dispatchedDefinition(firstMessage, 'Done'), frozen.definitionPrompts.done);
  assert.match(firstMessage, /do not authorize new permissions.*deterministic checks or human review/);
  assert.equal(accepted.policy.tools, 'none', 'Team prompts never grant tools.');
  await f.restart();
  assert.equal(f.board.detail(frozen.id).status, 'queued', 'A fully prepared prompt snapshot remains safe to dispatch after restart.');
  await f.settle(frozen.id, 'waiting_input');
  assert.equal(f.calls[0].messages[0].text, firstMessage);
  await f.restart();
  task = f.board.executionDetail(frozen.id);
  const waiting = f.sessions.interactions.view(task.sessionId); assert.ok(waiting.pending);
  await f.board.interact({ action: 'answer', sessionId: task.sessionId, expectedRevision: waiting.revision, pendingId: waiting.pending.id, operationId: 'confirm-migration', answer: 'Preserve the existing database behavior.' });
  await f.settle(task.id);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].messages[0].text, firstMessage);
  assert.equal(f.calls[1].messages.filter(message => message.text.includes('Team workflow definitions pinned')).length, 1);
  assert.ok(f.calls[1].messages.some(message => message.text === 'Preserve the existing database behavior.'));
  assert.deepEqual(f.board.executionDetail(task.id).definitionPrompts, frozen.definitionPrompts);
  await f.board.create(f.input, frozen);
  assert.equal(f.calls.length, 2); assert.equal(f.preparations.length, 1);
  const changed = structuredClone(frozen); changed.definitionPrompts.done.content = 'A new team completion rule.';
  changed.definitionPrompts.done.sha256 = featureContentHash(changed.definitionPrompts.done.content);
  await assert.rejects(f.board.create(f.input, changed), /different input/);
});

test('definition prompts reject malformed reservations and cannot be supplied through the public task body', async t => {
  const f = await fixture(t), submission = { ...f.submission(), definitionPrompts: definitionPrompts(f.baseCommit) };
  await assert.rejects(f.board.create({ ...f.input, definitionPrompts: submission.definitionPrompts }), /unknown field/i);
  for (const changed of [
    { ...submission.definitionPrompts, commit: 'HEAD' },
    { ...submission.definitionPrompts, done: { ...submission.definitionPrompts.done, sha256: '0'.repeat(64) } },
    { ...submission.definitionPrompts, ready: { ...submission.definitionPrompts.ready, content: '' } },
  ]) await assert.rejects(f.board.create(f.input, { ...submission, definitionPrompts: changed }), error => testErrorCode(error) === 'invalid_input');
  await assert.rejects(f.board.create(f.input, { ...submission, baseCommit: undefined }), /reserved task source commit/);
  await assert.rejects(f.board.create(f.input, { ...submission, repositoryId: undefined }), /reserved repository assignment/);
  assert.equal(f.preparations.length, 0); assert.equal(f.calls.length, 0);
});

test('corrupt saved definition content and mismatched commits fail recovery before any model dispatch', async t => {
  for (const corruption of ['content', 'content-hash', 'commit', 'reservation', 'missing']) await t.test(corruption, async child => {
    const f = await fixture(child), submission = { ...f.submission(), definitionPrompts: definitionPrompts(f.baseCommit) };
    await f.board.create(f.input, submission);
    const path = join(f.state, 'taskboard.json'), saved = JSON.parse(await readFile(path, 'utf8'));
    if (corruption === 'missing') delete saved[0].definitionPrompts;
    else if (corruption === 'commit') saved[0].definitionPrompts.commit = f.headCommit;
    else {
      saved[0].definitionPrompts.ready.content = 'Unvalidated replacement.';
      if (corruption !== 'content') saved[0].definitionPrompts.ready.sha256 = featureContentHash(saved[0].definitionPrompts.ready.content);
      if (corruption === 'reservation') saved[0].submissionContextHash = submissionContextHash({ ...submission, definitionPrompts: saved[0].definitionPrompts });
    }
    await writeFile(path, JSON.stringify(saved));
    await assert.rejects(f.restart(), /prompt|source commit/i);
    assert.equal(f.calls.length, 0);
  });
});

test('implementation-tool dispatch includes the same team definitions without changing mandatory verification', async t => {
  const f = await fixture(t), submission = { ...f.submission(), definitionPrompts: definitionPrompts(f.baseCommit) };
  await f.board.create(f.input, submission);
  const task = f.board.executionDetail(submission.id);
  const prompt = originalPrompt({ ...task, implementation: { schemaVersion: 1, mode: 'worktree', baseCommit: f.baseCommit, approvedPaths: ['approved.txt'], checks: [{ id: 'tests', name: 'Run required tests', executable: 'node', args: ['--test'], fingerprint: 'f'.repeat(64) }] } });
  assert.match(prompt, /werk_candidate_check for EVERY required check/);
  assert.match(prompt, /Human review is required/);
  assert.deepEqual(dispatchedDefinition(prompt, 'Ready'), submission.definitionPrompts.ready);
  assert.deepEqual(dispatchedDefinition(prompt, 'Done'), submission.definitionPrompts.done);
  const legacy = originalPrompt({ ...task, definitionPrompts: undefined });
  assert.doesNotMatch(legacy, /Team workflow definitions|Definition of Ready|Definition of Done/);
});


test('reviewed answers can advance the implementation base without replacing frozen definition provenance', async t => {
  const f = await fixture(t);
  const submission = { ...f.submission(), baseCommit: f.headCommit, definitionPrompts: definitionPrompts(f.baseCommit) };
  await f.board.create(f.input, submission);
  let task = f.board.executionDetail(submission.id);
  assert.equal(task.baseCommit, f.headCommit);
  assert.equal(task.definitionPrompts.commit, f.baseCommit);
  assert.equal(f.preparations[0].pinned, f.headCommit);
  const prepared = f.sessions.interactions.turn(task.sessionId, task.currentTurnId).dispatch;
  assert.deepEqual(dispatchedDefinition(prepared.messages[0].text, 'Ready'), submission.definitionPrompts.ready);
  await f.restart();
  task = f.board.executionDetail(submission.id);
  assert.equal(task.baseCommit, f.headCommit);
  assert.deepEqual(task.definitionPrompts, submission.definitionPrompts);
  await f.board.create(f.input, submission);
  assert.equal(f.preparations.length, 1);
  assert.equal(f.calls.length, 0, 'No dispatch occurs while the worker is paused.');
});
