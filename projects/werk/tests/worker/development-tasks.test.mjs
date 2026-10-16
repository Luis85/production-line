import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkerSessions, createLocalTaskboard } from '../../src/worker/dist/worker/infrastructure/workspace-services.js';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { prepareRepositoryWorktree } from '../../src/worker/dist/worker/infrastructure/repositories.js';
import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';
import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';
import { SharedFeatureLifecycle } from '../../src/worker/dist/worker/application/shared-feature-lifecycle.js';

const run = promisify(execFile), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const complete = text => ({ type: 'completed', text });
const checkSource = "import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; assert.equal(readFileSync('approved.txt', 'utf8'), 'after\\n'); console.log('Checked the actual edited source.');";
async function git(directory, ...args) {
  return (await run('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], { windowsHide: true })).stdout.trim();
}
async function call(runtime, name, args, signal, allowFailure = false) {
  const result = await runtime.call(name, args, signal);
  if (!allowFailure) assert.notEqual(result.isError, true, JSON.stringify(result));
  return { result, value: JSON.parse(result.content.map(item => item.text).join('\n')) };
}
async function edit(runtime, signal, content = 'after\n') {
  const { value: candidate } = await call(runtime, 'werk_candidate_status', {}, signal);
  const expectedHash = candidate.files.find(file => file.path === 'approved.txt').hash;
  return call(runtime, 'werk_candidate_apply', { path: 'approved.txt', content, expectedHash }, signal);
}
const check = (runtime, signal, allowFailure = false) => call(runtime, 'werk_candidate_check', { preset: 'source-check' }, signal, allowFailure);

async function fixture(t, execute, { verification = true } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk-development-task-')));
  const repository = join(root, 'repo'), state = join(root, 'state');
  let sessions, board;
  t.after(async () => { try { await board?.close(); await sessions?.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  await mkdir(repository); await mkdir(state);
  await git(repository, 'init', '--initial-branch=main');
  await git(repository, 'config', 'core.autocrlf', 'false');
  await git(repository, 'config', 'user.name', 'Development fixture');
  await git(repository, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repository, 'approved.txt'), 'before\n');
  await git(repository, 'add', 'approved.txt');
  await git(repository, 'commit', '-m', 'Fixture baseline');
  const baseCommit = await git(repository, 'rev-parse', 'HEAD');
  const settings = new WorkerSettings(state); await settings.init();
  await settings.update({ provider: { id: 'openai-api', model: 'fixture', apiKey: 'fixture-never-sent' }, board: { paused: false } });
  const grant = async required => {
    const policy = settings.toolPolicy();
    await settings.updateToolAccess({ expectedRevision: policy.revision, builtins: { ...policy.builtins, files: true, commands: [{ id: 'source-check', name: 'Check edited source', executable: process.execPath, args: ['--input-type=module', '-e', checkSource], enabled: true, verification: required }] }, mcp: [] });
  };
  await grant(verification);
  let invocations = 0;
  const failures = [], requests = [];
  const factory = (connection, _directory, _transport, options) => ({
    configuration: { id: connection.id, model: connection.model, instruction: 'Controlled development fixture; no provider connection.' },
    capabilities: modelCapabilities,
    get toolManifest() { return options?.tools().manifest; },
    async reply() { throw Error('Structured execution required.'); },
    async execute(request, signal) {
      invocations++; requests.push(request);
      const runtime = options.tools(request.policy);
      const task = board.executionDetail(board.view().tasks.find(item => item.status === 'running').id);
      try { return await execute({ runtime, request, signal, task, invocation: invocations }); }
      catch (error) { failures.push(error); throw error; }
      finally { await runtime.close(); }
    },
  });
  const workspaces = { prepareWorktree: (selector, key, signal, commit) => prepareRepositoryWorktree(selector, key, signal, commit) };
  async function open() {
    sessions = createWorkerSessions(state, settings, factory); await sessions.init();
    board = createLocalTaskboard(state, settings, sessions, factory, workspaces); await board.init();
  }
  await open();
  return {
    root, state, repository, baseCommit, settings, requests, grant,
    get board() { return board; }, get sessions() { return sessions; }, get invocations() { return invocations; },
    request(id) { return sessions.requests.get(board.executionDetail(id).requestId); },
    async create() {
      await board.create({ title: 'Implement the approved fixture change', instruction: 'Change approved.txt to after and verify the actual source.', repository, paths: ['approved.txt'], provider: 'openai-api' });
      return board.view().tasks.at(-1).id;
    },
    async settle(id, expected) {
      await board.tick();
      for (let attempt = 0; attempt < 2000; attempt++) {
        const task = board.executionDetail(id);
        if (!['queued', 'running'].includes(task.status) && !sessions.executor.busy) {
          if (failures.length) throw failures[0];
          assert.equal(task.status, expected, task.error ?? 'Unexpected task outcome'); return task;
        }
        await delay(10);
      }
      if (failures.length) throw failures[0];
      throw Error('Task did not settle: ' + board.executionDetail(id).status);
    },
    async restart(beforeOpen) { await board.close(); await sessions.close(); await beforeOpen?.(); await open(); },
  };
}

test('a new implementation edits, fails a real check, repairs and verifies within one provider invocation', { timeout: 120000 }, async t => {
  const receipts = [];
  const f = await fixture(t, async ({ runtime, request, signal }) => {
    assert.equal(request.policy.development, true);
    assert.match(request.protocolInstructions, /plain-text summary/);
    assert.ok(request.toolManifest.tools.some(tool => tool.name === 'werk_candidate_apply'));
    await edit(runtime, signal, 'broken\n');
    const failed = await check(runtime, signal, true);
    assert.equal(failed.result.isError, true); assert.equal(failed.value.status, 'failed'); assert.notEqual(failed.value.exitCode, 0);
    receipts.push(failed.value);
    await edit(runtime, signal);
    const passed = await check(runtime, signal);
    assert.equal(passed.value.status, 'passed'); assert.equal(passed.value.exitCode, 0);
    assert.match(passed.value.stdout, /actual edited source/); receipts.push(passed.value);
    return complete('Implemented the approved change and repaired the failing check. Ready for human review.');
  });
  const id = await f.create(), accepted = f.board.executionDetail(id);
  assert.equal(accepted.implementation.mode, 'worktree'); assert.equal(accepted.implementation.baseCommit, f.baseCommit);
  const task = await f.settle(id, 'review');
  assert.equal(f.invocations, 1); assert.equal(receipts.length, 2);
  assert.notEqual(receipts[0].candidateDigest, receipts[1].candidateDigest);
  assert.equal(task.summary, 'Implemented the approved change and repaired the failing check. Ready for human review.');
  assert.match(task.patch, /-before\n\+after/);
  assert.equal(await readFile(join(task.worktree, 'approved.txt'), 'utf8'), 'after\n');
  assert.equal(await readFile(join(f.repository, 'approved.txt'), 'utf8'), 'before\n');
  assert.equal(await git(f.repository, 'rev-parse', 'HEAD'), f.baseCommit);
  assert.equal(await git(f.repository, 'status', '--porcelain'), '');
  assert.equal(task.developmentEvidence.checks.length, 1, 'Only the latest receipt for each required check is retained.');
  assert.equal(task.developmentCompletion.verified, true);
  const facts = f.request(id).execution.facts;
  assert.equal(facts['output.verificationPassed'], true);
  assert.equal(facts['output.requiredCheckCount'], 1);
  assert.equal(facts['output.candidateDigest'], receipts[1].candidateDigest);
  assert.equal(await readFile(join(f.state, 'local-review', id + '.patch'), 'utf8'), task.patch);
});

const incomplete = {
  unchanged: async () => {},
  'missing checks': async ({ runtime, signal }) => { await edit(runtime, signal); },
  'failed checks': async ({ runtime, signal }) => { await edit(runtime, signal, 'broken\n'); await check(runtime, signal, true); },
  'source changed after a passing check': async ({ runtime, signal, task }) => { await edit(runtime, signal); await check(runtime, signal); await writeFile(join(task.worktree, 'approved.txt'), 'unchecked later edit\n'); },
};
for (const [label, attempt] of Object.entries(incomplete)) test(`${label} cannot turn a model completion claim into review`, { timeout: 120000 }, async t => {
  const f = await fixture(t, async context => { await attempt(context); return complete('The model claims everything is complete.'); });
  const id = await f.create(), task = await f.settle(id, 'needs_rework');
  assert.equal(f.invocations, 1);
  assert.equal(task.developmentCompletion.verified, false);
  assert.equal(f.request(id).execution.facts['output.verificationPassed'], false);
  assert.notEqual(f.request(id).phase, 'done');
  assert.match(task.error, /Required checks did not pass/);
  assert.equal(await readFile(join(f.repository, 'approved.txt'), 'utf8'), 'before\n');
  await f.restart();
  await f.board.tick();
  assert.equal(f.board.executionDetail(id).status, 'needs_rework'); assert.equal(f.invocations, 1);
});

test('known verified completion restores its review projection after restart without another provider call', { timeout: 120000 }, async t => {
  const f = await fixture(t, async ({ runtime, signal }) => { await edit(runtime, signal); await check(runtime, signal); return complete('Verified change retained for review.'); });
  const id = await f.create(), task = await f.settle(id, 'review');
  const outputDigest = f.request(id).execution.outputDigest;
  await f.restart(async () => {
    const saved = JSON.parse(await readFile(join(f.state, 'taskboard.json'), 'utf8'));
    Object.assign(saved.find(item => item.id === id), { status: 'running', summary: null, finishedAt: null });
    await writeFile(join(f.state, 'taskboard.json'), JSON.stringify(saved));
    await rm(join(f.state, 'local-review', id + '.patch'));
  });
  await f.board.tick();
  const restored = f.board.executionDetail(id);
  assert.equal(restored.status, 'review'); assert.equal(f.invocations, 1);
  assert.equal(restored.patch, task.patch); assert.equal(restored.summary, task.summary);
  assert.equal(f.request(id).execution.outputDigest, outputDigest);
  assert.equal(await readFile(join(f.state, 'local-review', id + '.patch'), 'utf8'), task.patch);
  assert.equal(f.sessions.runs.list({ sessionId: task.sessionId }).rows.length, 1);
});

test('saved proposal tasks never gain implementation authority when required checks are enabled later', { timeout: 120000 }, async t => {
  const f = await fixture(t, async ({ runtime, request, invocation }) => {
    assert.equal(request.policy.development, undefined);
    assert.equal(runtime.manifest.tools.some(tool => tool.name.startsWith('werk_candidate_')), false);
    if (invocation === 1) return { type: 'needs_input', request: { schemaVersion: 1, kind: 'question', message: 'Use the approved proposed change?' } };
    return complete(JSON.stringify({ summary: 'Legacy review patch; tests not run.', files: [{ path: 'approved.txt', content: 'after\n' }] }));
  }, { verification: false });
  const id = await f.create(), waiting = await f.settle(id, 'waiting_input');
  assert.equal(waiting.implementation, undefined);
  await f.grant(true); await f.restart();
  const interaction = f.sessions.interactions.view(waiting.sessionId);
  await f.board.interact({ action: 'answer', sessionId: waiting.sessionId, pendingId: interaction.pending.id, expectedRevision: interaction.revision, operationId: 'legacy-proposal-answer', answer: 'Use the proposed change.' });
  const task = await f.settle(id, 'review');
  assert.equal(f.invocations, 2); assert.equal(task.implementation, undefined);
  assert.equal(task.developmentEvidence, undefined); assert.equal(task.developmentCompletion, undefined);
  assert.equal(f.request(id).execution.facts['output.verificationPassed'], undefined);
  assert.match(task.patch, /-before\n\+after/);
  assert.equal(await readFile(join(task.worktree, 'approved.txt'), 'utf8'), 'before\n');
  assert.equal(await readFile(join(f.repository, 'approved.txt'), 'utf8'), 'before\n');
});

test('implementation questions preserve candidate work and immutable result facts across restart and resume', { timeout: 120000 }, async t => {
  const f = await fixture(t, async ({ runtime, request, signal, invocation }) => {
    assert.equal(request.policy.development, true);
    if (invocation === 1) {
      await edit(runtime, signal, 'work awaiting a decision\n');
      return { type: 'needs_input', request: { schemaVersion: 1, kind: 'question', message: 'Use the verified final behavior?' } };
    }
    assert.match(request.messages.map(message => message.text).join('\n'), /Use the final behavior/);
    const { value: retained } = await call(runtime, 'werk_files_read', { path: 'approved.txt' }, signal);
    assert.equal(retained.text, 'work awaiting a decision\n');
    await edit(runtime, signal); await check(runtime, signal);
    return complete('Implemented the selected behavior and verified the retained candidate.');
  });
  const id = await f.create(), waiting = await f.settle(id, 'waiting_input');
  const savedExecution = structuredClone(f.request(id).execution);
  const pending = f.sessions.interactions.view(waiting.sessionId).pending.id;
  assert.equal(savedExecution.facts['output.verificationPassed'], false);
  assert.equal(savedExecution.facts['output.requiredCheckCount'], 1);
  await f.restart();
  assert.equal(f.board.executionDetail(id).status, 'waiting_input'); assert.equal(f.invocations, 1);
  assert.deepEqual(f.request(id).execution, savedExecution, 'Recovery must replay the exact known question facts.');
  const interaction = f.sessions.interactions.view(waiting.sessionId);
  assert.equal(interaction.pending.id, pending);
  await f.board.interact({ action: 'answer', sessionId: waiting.sessionId, pendingId: pending, expectedRevision: interaction.revision, operationId: 'implementation-answer', answer: 'Use the final behavior.' });
  const completed = await f.settle(id, 'review');
  assert.equal(f.invocations, 2); assert.equal(completed.developmentCompletion.verified, true);
  assert.equal(f.request(id).execution.facts['output.verificationPassed'], true);
  assert.equal(await readFile(join(f.repository, 'approved.txt'), 'utf8'), 'before\n');
});

function useMinimalDonePolicy(f) {
  const policy = defaultGatePolicy();
  policy.done.patch = [{ id: 'summary-present', fact: 'output.nonEmpty', op: 'eq', value: true }];
  f.sessions.requests.setPolicy({ policy, expectedRevision: f.sessions.requests.policy().revision, operationId: 'minimal-completion-policy' });
}

test('custom completion rules cannot mark unverified implementation work done or hide shared rework', { timeout: 120000 }, async t => {
  const f = await fixture(t, async ({ runtime, signal }) => { await edit(runtime, signal); return complete('A nonempty summary without required checks.'); });
  useMinimalDonePolicy(f);
  const id = await f.create(), task = await f.settle(id, 'needs_rework'), request = f.request(id);
  assert.equal(request.phase, 'needs_rework');
  assert.equal(request.execution.facts['output.nonEmpty'], true);
  assert.equal(request.execution.facts['output.verificationPassed'], false);
  const done = request.evaluations.filter(item => item.stage === 'done').at(-1);
  assert.equal(done.passed, false);
  assert.ok(done.rules.some(rule => rule.ruleId === 'worker-required-verification' && rule.result === 'fail'));

  const writes = [], record = {
    id: 'feature-unverified', title: 'Unverified implementation', taskId: id,
    sourcePath: 'features/unverified.md', sourceCommit: f.baseCommit, remoteRevision: 'a'.repeat(64),
    binding: {}, workflow: { policyDigest: request.policyDigest },
    status: 'queued', error: null, claimed: true, submitted: true, publication: 'synced',
  };
  const lifecycle = new SharedFeatureLifecycle({
    inspect: taskId => { assert.equal(taskId, id); return { ...task, request, developmentVerified: false }; },
    repository: () => ({
      async publishLifecycle(write) { writes.push(structuredClone(write)); return { commit: 'b'.repeat(40), head: 'b'.repeat(40) }; },
      async publishPatch() { assert.fail('Unverified implementation must not publish a feature branch.'); },
    }),
    renderSource: value => JSON.stringify({ status: value.status, done: value.done, error: value.error }),
  }, async () => {});
  await lifecycle.reconcile(record, new AbortController().signal);
  assert.equal(record.status, 'needs_rework'); assert.equal(record.publication, 'synced');
  assert.equal(record.done.passed, false);
  assert.ok(record.done.issues.some(issue => issue.includes('worker-required-verification')));
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].request.content).status, 'needs_rework');
  await f.restart();
  assert.equal(f.request(id).phase, 'needs_rework'); assert.equal(f.invocations, 1);
});

test('verified implementation satisfies a custom completion policy after its required check passes', { timeout: 120000 }, async t => {
  const f = await fixture(t, async ({ runtime, signal }) => { await edit(runtime, signal); await check(runtime, signal); return complete('Verified implementation summary.'); });
  useMinimalDonePolicy(f);
  const id = await f.create(); await f.settle(id, 'review');
  const request = f.request(id);
  assert.equal(request.execution.facts['output.verificationPassed'], true);
  assert.equal(request.phase, 'done');
  assert.equal(request.evaluations.filter(item => item.stage === 'done').at(-1).passed, true);
});

test('legacy proposal completion remains compatible with a custom policy when verification facts are absent', { timeout: 120000 }, async t => {
  const f = await fixture(t, async () => complete(JSON.stringify({ summary: 'Legacy proposal summary.', files: [{ path: 'approved.txt', content: 'after\n' }] })), { verification: false });
  useMinimalDonePolicy(f);
  const id = await f.create(), task = await f.settle(id, 'review'), request = f.request(id);
  assert.equal(task.implementation, undefined);
  assert.equal(request.execution.facts['output.verificationPassed'], undefined);
  assert.equal(request.phase, 'done');
  assert.equal(request.evaluations.filter(item => item.stage === 'done').at(-1).passed, true);
  assert.equal(await readFile(join(task.worktree, 'approved.txt'), 'utf8'), 'before\n');
});
