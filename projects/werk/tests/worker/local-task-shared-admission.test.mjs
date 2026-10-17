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
  const factory = connection => ({
    configuration: { id: connection.id, model: connection.model, instruction: 'Fixture only; no external calls' },
    capabilities: modelCapabilities,
    async execute(request) { calls.push(request); return { type: 'completed', text: JSON.stringify({ summary: 'Fixture patch; tests not run.', files: [{ path: 'approved.txt', content: 'proposed change\n' }] }) }; },
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
    sessions = new WorkerSessions(state, settings, factory); await sessions.init();
    board = new LocalTaskboard(state, settings, sessions, factory, port); await board.init();
  }
  await open();
  t.after(async () => { await board.close(); await sessions.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    state, repository, baseCommit, headCommit, settings, calls, preparations,
    get board() { return board; }, get sessions() { return sessions; },
    input: { title: 'Shared feature', instruction: 'Change only the approved file.', repository, paths: ['approved.txt'], provider: 'openai-api' },
    submission(policy = defaultGatePolicy()) { return { id: 'shared-feature-task', hash: 'a'.repeat(64), repositoryId: 'shared', baseCommit, criteria: ['Approved content changes.'], policy }; },
    async restart() { await board.close(); await sessions.close(); await open(); },
    async settle(id) { await board.tick(); for (let i = 0; i < 400; i++) { if (board.detail(id).status === 'review' && !sessions.executor.busy) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error('Task did not produce review output'); },
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
    await assert.rejects(f.board.create(f.input, { ...submission, ...change }), error => error.code === 'invalid_input');
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
