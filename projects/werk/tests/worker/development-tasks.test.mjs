import { trackingSharedRecord, trackingWorkflow } from './tracking-fixtures.mjs';
import test from 'node:test';
import { createProcessObservation } from '../../src/worker/dist/worker/infrastructure/process-observation.js';
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
import { sharedFeatureRequestReference } from '../../src/worker/dist/worker/application/feature-request-reference.js';

const run = promisify(execFile), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const attemptSettleTimeoutMs = 20000;
// Native Windows containment adds process startup cost to each Git/check operation.
const settleTimeoutMs = process.platform === 'win32' ? 120000 : attemptSettleTimeoutMs;
const testTimeoutMs = process.platform === 'win32' ? 180000 : 120000;
const multiPhaseTimeoutMs = process.platform === 'win32' ? 240000 : testTimeoutMs;
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

async function fixture(t, execute, { verification = true, native = false, observations = /** @type {import('../../src/worker/application/process-observation.ts').ProcessObservation | undefined} */ (undefined) } = {}) {
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
  await settings.update({ provider: { id: native ? 'cursor-cli' : 'openai-api', model: 'fixture', apiKey: 'fixture-never-sent' }, board: { paused: false } });
  const grant = async required => {
    const policy = settings.toolPolicy();
    await settings.updateToolAccess({ expectedRevision: policy.revision, builtins: { ...policy.builtins, files: true, commands: [{ id: 'source-check', name: 'Check edited source', executable: process.execPath, args: ['--input-type=module', '-e', checkSource], enabled: true, verification: required }] }, mcp: [] });
  };
  await grant(verification);
  let invocations = 0;
  const failures = [], requests = [];
  const factory = (connection, _directory, _transport, options) => ({
    configuration: { id: connection.id, model: connection.model, instruction: 'Controlled development fixture; no provider connection.' },
    capabilities: { ...modelCapabilities, ...(native ? { tools: /** @type {const} */ ('provider_native') } : {}) },
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
  const worktreeInspections = [];
  const workspaces = { prepareWorktree: (selector, key, signal, commit, inspection) => { worktreeInspections.push(inspection); return prepareRepositoryWorktree(selector, key, signal, commit, inspection); } };
  async function open() {
    const processes = observations ? { observations, supervisor: () => undefined } : undefined;
    sessions = createWorkerSessions(state, settings, factory, undefined, () => 0, undefined, undefined, processes); await sessions.init();
    board = createLocalTaskboard(state, settings, sessions, factory, workspaces, undefined, processes); await board.init();
  }
  await open();
  return {
    root, state, repository, baseCommit, settings, requests, grant, worktreeInspections,
    get board() { return board; }, get sessions() { return sessions; }, get invocations() { return invocations; },
    request(id) { return sessions.requests.get(board.executionDetail(id).requestId); },
    async create(paths = ['approved.txt'], submission = undefined) {
      await board.create({ title: 'Implement the approved fixture change', instruction: 'Change approved.txt to after and verify the actual source.', repository, paths, provider: native ? 'cursor-cli' : 'openai-api' }, submission);
      return board.view().tasks.at(-1).id;
    },
    async settle(id, expected) {
      // Exhaustion includes a real check and Git checkpoint for every frozen repair attempt.
      const requestId = board.executionDetail(id).requestId;
      const repairAttempts = expected === 'needs_rework' && requestId ? sessions.requests.get(requestId).delivery?.maxRepairAttempts ?? 0 : 0;
      const budgetMs = Math.max(settleTimeoutMs, attemptSettleTimeoutMs * (repairAttempts + 1));
      const started = performance.now(), deadline = started + budgetMs;
      await board.tick();
      for (;;) {
        const task = board.executionDetail(id);
        if (!['queued', 'running'].includes(task.status) && !sessions.executor.busy) {
          if (failures.length) throw failures[0];
          assert.equal(task.status, expected, task.error ?? 'Unexpected task outcome'); return task;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0 || t.signal.aborted) break;
        await delay(Math.min(25, remaining));
      }
      if (failures.length) throw failures[0];
      const task = board.executionDetail(id);
      throw Error(`Task ${id} did not settle after ${Math.round(performance.now() - started)} ms (limit ${budgetMs} ms): expected ${expected}, status ${task.status}, executor busy=${sessions.executor.busy}, provider invocations=${invocations}, test aborted=${t.signal.aborted}${task.error ? '; last error: ' + task.error : ''}`);
    },
    async restart(beforeOpen) { await board.close(); await sessions.close(); await beforeOpen?.(); await open(); },
  };
}

test('a new implementation edits, fails a real check, repairs and verifies within one provider invocation', { timeout: testTimeoutMs }, async t => {
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
  assert.equal(f.sessions.detail(task.sessionId).chat.messages.at(-1).text, task.summary, 'A verified implementation retains its plain-text completion without parsing it as replacement JSON.');
  assert.equal(f.board.view().persistenceError, false, 'Formatting must not create a false persistence failure after successful implementation.');
  assert.equal(f.sessions.interactions.turn(task.sessionId, task.currentTurnId).result.text, task.summary);
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

test('candidate inspection uses the limits frozen with the accepted dispatch, not a later settings change', { timeout: testTimeoutMs }, async t => {
  const f = await fixture(t, async ({ runtime, request, signal }) => {
    assert.equal(request.policy.candidateFileMaxBytes, 8388608); assert.equal(request.toolManifest.limits.candidateInspection.candidateFileMaxBytes, 8388608);
    await edit(runtime, signal); await check(runtime, signal);
    return complete('Verified with the accepted inspection limits.');
  });
  await writeFile(join(f.repository, 'asset.bin'), Buffer.alloc(70 * 1024, 1));
  await git(f.repository, 'add', 'asset.bin'); await git(f.repository, 'commit', '-m', 'Committed asset above the later per-file limit');
  const id = await f.create();
  f.worktreeInspections.length = 0;
  await f.settings.update({ execution: { candidateFileMaxBytes: 65536, candidateSourceMaxFiles: 1 } });
  const task = await f.settle(id, 'review');
  assert.equal(task.developmentCompletion.verified, true);
  assert.ok(f.worktreeInspections.length > 1);
  assert.ok(f.worktreeInspections.every(value => value.candidateSourceMaxFiles === 20000), 'initial execution and later candidate guards use accepted limits, not live settings');
  assert.equal(f.settings.publicView().execution.candidateFileMaxBytes, 65536, 'the later change applies to new attempts only');
});

test('an approved folder admits generated files under the frozen approved content limits', { timeout: testTimeoutMs }, async t => {
  const generated = 'x'.repeat(26000) + '\n';
  const f = await fixture(t, async ({ runtime, request, signal, task }) => {
    assert.equal(request.policy.candidateApprovedFileMaxBytes, 30000); assert.equal(request.toolManifest.limits.candidateReview.candidateApprovedTotalMaxBytes, 60000);
    assert.deepEqual(task.files.find(file => file.path === 'gen/'), { path: 'gen/', content: '', existed: false }, 'folder snapshots hold no contents');
    assert.match(request.messages[0].text, /Approved folders end in \//);
    // A project generator writes the component folder directly; the frozen 30,000-byte bound admits it.
    await mkdir(join(task.worktree, 'gen', 'component'), { recursive: true }); await writeFile(join(task.worktree, 'gen', 'component', 'view.ts'), generated);
    await edit(runtime, signal); await check(runtime, signal);
    return complete('Generated the component and verified it.');
  });
  await f.settings.update({ execution: { candidateApprovedFileMaxBytes: 30000, candidateApprovedTotalMaxBytes: 60000 } });
  const id = await f.create(['approved.txt', 'gen/']);
  await f.settings.update({ execution: { candidateApprovedFileMaxBytes: 24000, candidateApprovedTotalMaxBytes: 48000 } });
  const task = await f.settle(id, 'review');
  assert.equal(task.developmentCompletion.verified, true);
  assert.match(task.patch, /gen\/component\/view\.ts/); assert.match(task.patch, /\+after/);
  assert.equal(task.changedFileCount, 2);
});

test('shared intake admission freezes the publication bounds that candidate status reports; local admission does not', { timeout: multiPhaseTimeoutMs }, async t => {
  const reported = [];
  const f = await fixture(t, async ({ runtime, signal, invocation }) => {
    reported.push((await call(runtime, 'werk_candidate_status', {}, signal)).value.sharedPublication);
    if (invocation > 1) return complete('Only inspected the local candidate.');
    await edit(runtime, signal); await check(runtime, signal);
    return complete('Verified within the frozen bounds.');
  });
  const feature = sharedFeatureRequestReference({ id: 'shared-change', sourcePath: 'features/shared-change.md', binding: { repositoryId: 'project', remote: 'origin', branch: 'main', workflowPath: 'werk/workflow.json' } });
  const shared = await f.create(['approved.txt'], { id: 'shared-change-task', hash: 'b'.repeat(64), feature });
  assert.equal(shared, 'shared-change-task');
  assert.deepEqual(f.board.executionDetail(shared).implementation.sharedPublication, { patchMaxBytes: 131072, changedFilesMax: 32 });
  assert.equal((await f.settle(shared, 'review')).developmentCompletion.verified, true);
  await f.create();
  const local = f.board.view().tasks.find(task => task.id !== shared).id;
  assert.equal(Object.hasOwn(f.board.executionDetail(local).implementation, 'sharedPublication'), false);
  await f.settle(local, 'needs_rework');
  assert.deepEqual(reported[0], { patchMaxBytes: 131072, changedFilesMax: 32, patchBytes: 0, changedFileCount: 0 });
  assert.equal(reported.length, 5, 'The local candidate uses its bounded three repair attempts.');
  assert.ok(reported.slice(1).every(item => item === undefined));
});

test('proposal requests keep exact files: a folder approval is refused before a worktree is prepared', { timeout: testTimeoutMs }, async t => {
  const f = await fixture(t, async () => complete('unused'), { verification: false });
  await assert.rejects(f.create(['approved.txt', 'gen/']), /Folder approvals \(paths ending in \/\) require an implementation request/);
  assert.equal(f.board.view().tasks.length, 0); assert.deepEqual(f.worktreeInspections, []);
});

const incomplete = {
  unchanged: async () => {},
  'failed checks': async ({ runtime, signal }) => { await edit(runtime, signal, 'broken\n'); await check(runtime, signal, true); },
  'source changed after a passing check': async ({ runtime, signal, task }) => { await edit(runtime, signal); await check(runtime, signal); await writeFile(join(task.worktree, 'approved.txt'), 'unchecked later edit\n'); },
};
for (const [label, attempt] of Object.entries(incomplete)) test(`${label} cannot turn a model completion claim into review`, { timeout: testTimeoutMs }, async t => {
  const f = await fixture(t, async context => { await attempt(context); return complete('The model claims everything is complete.'); });
  const id = await f.create(), task = await f.settle(id, 'needs_rework');
  assert.equal(f.invocations, 4);
  assert.equal(f.request(id).delivery.repairAttempts, 3);
  assert.equal(f.request(id).delivery.status, 'failed');
  assert.equal(task.developmentCompletion.verified, false);
  assert.equal(f.request(id).execution.facts['output.verificationPassed'], false);
  assert.notEqual(f.request(id).phase, 'done');
  assert.match(task.error, /Required checks did not pass/);
  assert.equal(await readFile(join(f.repository, 'approved.txt'), 'utf8'), 'before\n');
  await f.restart();
  await f.board.tick();
  assert.equal(f.board.executionDetail(id).status, 'needs_rework'); assert.equal(f.invocations, 4);
});

test('known verified completion restores its review projection after restart without another provider call', { timeout: testTimeoutMs }, async t => {
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

test('saved proposal tasks never gain implementation authority when required checks are enabled later', { timeout: multiPhaseTimeoutMs }, async t => {
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

test('implementation questions preserve candidate work and immutable result facts across restart and resume', { timeout: multiPhaseTimeoutMs }, async t => {
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

test('custom completion rules cannot mark unverified implementation work done or hide shared rework', { timeout: testTimeoutMs }, async t => {
  const f = await fixture(t, async ({ runtime, signal }) => { await edit(runtime, signal, 'broken\n'); return complete('A nonempty summary despite failed source behavior.'); });
  useMinimalDonePolicy(f);
  const id = await f.create(), task = await f.settle(id, 'needs_rework'), request = f.request(id);
  assert.equal(request.phase, 'needs_rework');
  assert.equal(request.execution.facts['output.nonEmpty'], true);
  assert.equal(request.execution.facts['output.verificationPassed'], false);
  const done = request.evaluations.filter(item => item.stage === 'done').at(-1);
  assert.equal(done.passed, false);
  assert.ok(done.rules.some(rule => rule.ruleId === 'worker-required-verification' && rule.result === 'fail'));

  const writes = [], record = trackingSharedRecord({
    id: 'feature-unverified', title: 'Unverified implementation', taskId: id,
    sourcePath: 'features/unverified.md', sourceCommit: f.baseCommit, remoteRevision: 'a'.repeat(64),
    workflow: trackingWorkflow({ policyDigest: request.policyDigest }),
    status: 'queued', error: null, claimed: true, submitted: true, publication: 'synced',
  });
  const unexpected = () => { throw Error('Unexpected shared intake operation.'); };
  const lifecycle = new SharedFeatureLifecycle({
    load: unexpected, save: unexpected, loadWorkflow: unexpected, ready: unexpected, source: unexpected, submit: unexpected, canAdmit: unexpected,
    inspect: taskId => { assert.equal(taskId, id); return { ...task, request, developmentVerified: false }; },
    repository: () => ({
      async head() { throw Error('Unexpected repository read.'); },
      async readBlob() { throw Error('Unexpected repository read.'); },
      async listRequests() { throw Error('Unexpected repository read.'); },
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
  assert.equal(f.request(id).phase, 'needs_rework'); assert.equal(f.invocations, 4);
});

test('verified implementation satisfies a custom completion policy after its required check passes', { timeout: testTimeoutMs }, async t => {
  const f = await fixture(t, async ({ runtime, signal }) => { await edit(runtime, signal); await check(runtime, signal); return complete('Verified implementation summary.'); });
  useMinimalDonePolicy(f);
  const id = await f.create(); await f.settle(id, 'review');
  const request = f.request(id);
  assert.equal(request.execution.facts['output.verificationPassed'], true);
  assert.equal(request.phase, 'review', 'Passing automated checks does not imply human acceptance.');
  assert.equal(request.evaluations.filter(item => item.stage === 'done').at(-1).passed, true);
});

test('legacy proposal completion remains compatible with a custom policy when verification facts are absent', { timeout: testTimeoutMs }, async t => {
  const f = await fixture(t, async () => complete(JSON.stringify({ summary: 'Legacy proposal summary.', files: [{ path: 'approved.txt', content: 'after\n' }] })), { verification: false });
  useMinimalDonePolicy(f);
  const id = await f.create(), task = await f.settle(id, 'review'), request = f.request(id);
  assert.equal(task.implementation, undefined);
  assert.equal(request.execution.facts['output.verificationPassed'], undefined);
  assert.equal(request.phase, 'done');
  assert.equal(request.evaluations.filter(item => item.stage === 'done').at(-1).passed, true);
  assert.equal(await readFile(join(task.worktree, 'approved.txt'), 'utf8'), 'before\n');
});


test('task observation includes candidate capture after model execution with the same FR and run', { timeout: testTimeoutMs }, async t => {
  const observations = createProcessObservation();
  let atProviderEnd = new Set();
  const f = await fixture(t, async ({ runtime, signal }) => {
    await edit(runtime, signal); await check(runtime, signal);
    atProviderEnd = new Set((await observations.status()).processes.map(record => record.id));
    return complete('Edited and verified the candidate.');
  }, { observations });
  const id = await f.create(), task = await f.settle(id, 'review');
  const afterModel = (await observations.status()).processes.filter(record => !atProviderEnd.has(record.id));
  assert.ok(afterModel.some(record => record.kind === 'git'), 'final candidate capture remains visible after the provider returns');
  for (const record of afterModel) {
    assert.equal(record.featureRequestKey, task.feature.key); assert.equal(record.taskId, id);
    assert.equal(record.sessionId, task.sessionId); assert.equal(record.runId, task.runId);
  }
});


test('native provider edits are verified by the worker before the same Feature Request reaches review', { timeout: testTimeoutMs }, async t => {
  const f = await fixture(t, async ({ request, task }) => {
    assert.equal(request.policy.tools, 'provider_native');
    assert.equal(request.policy.filesystem, 'provider_permissions');
    assert.equal(request.policy.development, true);
    await writeFile(join(task.worktree, 'approved.txt'), 'after\n');
    return complete('Implemented through native tools; awaiting worker verification.');
  }, { native: true });
  const id = await f.create(), task = await f.settle(id, 'review');
  assert.equal(f.invocations, 1); assert.equal(task.developmentCompletion.verified, true);
  assert.equal(task.developmentEvidence.checks.length, 1);
  assert.equal(task.developmentEvidence.checks[0].status, 'passed');
  assert.match(task.developmentEvidence.checks[0].stdout, /actual edited source/);
  assert.equal(f.request(id).execution.facts['output.verificationPassed'], true);
  assert.equal(f.request(id).owner.featureId, task.feature.key);
  assert.equal(await readFile(join(f.repository, 'approved.txt'), 'utf8'), 'before\n');
  await f.restart(); await f.board.tick(); assert.equal(f.invocations, 1);
});


test('worker verification establishes evidence when the model omits checks', { timeout: testTimeoutMs }, async t => {
  const f = await fixture(t, async ({ runtime, signal }) => { await edit(runtime, signal); return complete('Implemented source; worker must verify it.'); });
  const id = await f.create(), task = await f.settle(id, 'review');
  assert.equal(f.invocations, 1); assert.equal(task.developmentCompletion.verified, true);
  assert.equal(task.developmentEvidence.checks[0].status, 'passed');
  assert.match(task.developmentEvidence.checks[0].stdout, /actual edited source/);
  assert.equal(f.request(id).phase, 'review');
});

test('live review verification rejects a changed worktree and acceptance binds the real local commit', { timeout: testTimeoutMs }, async t => {
  const f = await fixture(t, async ({ runtime, signal }) => { await edit(runtime, signal); await check(runtime, signal); return complete('Verified source change for human review.'); });
  const id = await f.create(['approved.txt'], { id: 'review-acceptance-task', hash: 'e'.repeat(64), criteria: ['Confirm the approved source behavior.'] });
  const task = await f.settle(id, 'review');
  let request = f.request(id);
  const review = request.delivery.review;
  assert.ok(review); assert.equal(request.phase, 'review');
  assert.equal(await git(f.repository, 'rev-parse', review.candidate.branch), review.candidate.candidateCommit);
  assert.equal(await f.board.verifyDelivery(request.id, request.revision), review.candidate.candidateDigest);
  await writeFile(join(task.worktree, 'approved.txt'), 'unreviewed change\n');
  await assert.rejects(f.board.verifyDelivery(request.id, request.revision), /changed/);
  assert.equal(f.request(id).phase, 'review');
  await writeFile(join(task.worktree, 'approved.txt'), 'after\n');
  request = f.request(id);
  await f.board.verifyDelivery(request.id, request.revision);
  const command = { action: 'attest', requestId: request.id, expectedRevision: request.revision, operationId: 'accept-reviewed-candidate', inputRevision: request.inputRevision,
    inputHash: request.inputHash, outputDigest: request.execution.outputDigest, candidateCommit: review.candidate.candidateCommit, candidateDigest: review.candidate.candidateDigest,
    note: 'Inspected the exact local candidate.', humanOutcomes: review.criteria.filter(item => item.evaluator === 'human').map(item => ({ criterionId: item.id, outcome: 'passed', reason: 'Observed approved.txt containing the required after value.' })) };
  assert.equal(f.sessions.requests.command(command).request.phase, 'done');
  assert.equal(f.sessions.requests.replayCommand(command).duplicate, true);
  assert.equal(await git(f.repository, 'rev-parse', 'HEAD'), f.baseCommit, 'Acceptance does not merge into the project baseline.');
});
