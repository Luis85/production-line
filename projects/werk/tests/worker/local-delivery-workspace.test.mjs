import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { workspaceModelFactory } from '../../src/worker/dist/worker/infrastructure/workspace-services.js';
import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';
import { defaultDeliveryProjectPolicy } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { parseFeature } from '../../src/worker/dist/worker/infrastructure/features/document.js';
import { workerStatus } from '../helpers/worker-status.mjs';
import { taskboardRuntime, workspaceContext } from './runtime-fixtures.mjs';

prepareNativeProcessFixture();

const timeout = process.platform === 'win32' ? 240000 : 90000;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args], {
  cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
}).trim();
const source = 'export const value = 2;\n';
const markdown = `---
schema: worker.request/v1
id: FR-0042
title: Deliver the visible value two
intent: submit
mode: patch
provider: openai-api
paths: [src/]
priority: normal
---
# Deliver the visible value two

## Outcome

Change the exported value to two without changing unrelated project work.

## Acceptance criteria

- AC-01: The exported value is two and the original checkout remains untouched.

## Boundaries

Only implementation source in src is approved. Keep the committed check unchanged.

## Answers

`;

/** Only the model port is a fixture. Git, checks, lifecycle, candidate, review and journals are production adapters. */
async function fixture(t, { paused = false, requiredCheck = true, exactFile = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk-delivery-workspace-')));
  const project = join(root, 'project'), state = join(root, 'state'), intake = join(project, 'features');
  await mkdir(join(project, 'src'), { recursive: true }); await mkdir(join(project, 'tests')); await mkdir(join(project, '.werk')); await mkdir(intake);
  git(project, 'init', '--initial-branch=main'); git(project, 'config', 'core.autocrlf', 'false');
  git(project, 'config', 'user.name', 'Werk Acceptance'); git(project, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(project, 'src', 'value.mjs'), 'export const value = 1;\n');
  await writeFile(join(project, 'tests', 'value.test.mjs'), "import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; assert.equal(value, 2); console.log('Observed candidate value two.');\n");
  await writeFile(join(project, '.werk', 'delivery-policy.json'), JSON.stringify(defaultDeliveryProjectPolicy()));
  await writeFile(join(project, 'user.txt'), 'original\n'); git(project, 'add', '.'); git(project, 'commit', '-m', 'Committed source and trusted verification');
  await writeFile(join(project, 'user.txt'), 'staged work\n'); git(project, 'add', 'user.txt');
  await writeFile(join(project, 'user.txt'), 'unstaged work\n'); await writeFile(join(project, 'private-untracked.txt'), 'retain this local work\n');
  const before = { head: git(project, 'rev-parse', 'HEAD'), index: git(project, 'write-tree'), staged: git(project, 'diff', '--cached'), unstaged: git(project, 'diff') };
  let calls = 0, networkAttempts = 0;
  const modelFailures = [];
  t.mock.method(globalThis, 'fetch', async () => { networkAttempts++; throw Error('The local acceptance fixture must not use HTTP or a vendor.'); });
  /** @type {WorkerWorkspace | undefined} */
  let worker;
  /** @type {SnapshotJournal | undefined} */
  let journal;
  /** @type {import('../../src/worker/infrastructure/workspace-services.js').WorkspaceProviderFactory} */
  const factory = (connection, _directory, _transport, options) => ({
    configuration: { id: connection.id, model: connection.model, authenticationMode: connection.authenticationMode, instruction: '' },
    capabilities: modelCapabilities,
    get toolManifest() { return options.tools().manifest; },
    toolManifestFor(policy) { return options.tools(policy).manifest; },
    async reply() { throw Error('Expected typed dispatch.'); },
    async execute(dispatch, signal) {
      calls++;
      const runtime = options.tools(dispatch.policy);
      try {
        assert.equal(dispatch.provider.authenticationMode, 'api-key');
        assert.equal(dispatch.policy.development, true);
        assert.match(dispatch.renderedPrompt, /AC-01/);
        const status = await runtime.call('werk_candidate_status', {}, signal);
        assert.notEqual(status.isError, true, JSON.stringify(status));
        const candidate = JSON.parse(status.content.map(item => item.text).join('\n'));
        const file = candidate.files.find(item => item.path === 'src/value.mjs'); assert.ok(file?.hash);
        const applied = await runtime.call('werk_candidate_apply', { path: 'src/value.mjs', content: source, expectedHash: file.hash }, signal);
        assert.notEqual(applied.isError, true, JSON.stringify(applied));
        return { type: 'completed', text: 'Implemented the approved value change. The worker must verify the candidate and await human review.' };
      } catch (error) { modelFailures.push(error); throw error; }
      finally { await runtime.close(); }
    },
  });
  async function open() {
    journal = new SnapshotJournal(state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
    worker = new WorkerWorkspace({ stateDir: state, projectDir: project, pollMs: 1000, timeoutMs: 60000,
      features: { directory: intake, provider: 'openai-api', intake: 'local', pollMs: 1000 } }, journal, workerStatus);
    const context = workspaceContext(worker);
    taskboardRuntime(worker.board).model = workspaceModelFactory(state, worker.settings, factory, worker.consumption, worker.sessions.runs,
      { supervisor: () => context.processes, observations: context.processObservations });
    await worker.init();
  }
  async function close() { await worker?.close(); worker = undefined; journal?.close(); journal = undefined; }
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  await open();
  await worker.updateSettings({ provider: { id: 'openai-api', authenticationMode: 'api-key', apiKey: 'fixture-never-sent', model: 'fixture-local' }, board: { paused: true } });
  const discovered = worker.repositoryStatus().discovery;
  await worker.repositoryCommand({ action: 'accept', discoveryId: discovered.id });
  async function configureChecks(enabled) {
    const grant = worker.settings.toolPolicy();
    await worker.updateToolAccess({ expectedRevision: grant.revision, builtins: { ...grant.builtins, files: true, commands: enabled ? [
      { id: 'value-test', name: 'Check exported candidate value', executable: process.execPath, args: ['tests/value.test.mjs'], enabled: true, verification: true },
    ] : [] }, mcp: [] });
  }
  await configureChecks(requiredCheck);
  const policy = worker.sessions.requests.policy(); policy.policy.reviewer.enabled = false;
  await worker.requestCommand({ action: 'set_policy', expectedRevision: policy.revision, operationId: 'fixture-human-review', policy: policy.policy });
  assert.equal(worker.settings.value.repositories.items[0].watch, false);
  assert.equal(git(project, 'remote'), '', 'This local journey has no remote or push destination.');
  await worker.updateSettings({ board: { paused } });
  await writeFile(join(intake, 'FR-0042.md'), exactFile ? markdown.replace('paths: [src/]', 'paths: [src/value.mjs]') : markdown);
  const current = () => {
    const record = workspaceContext(worker).features.view().records.find(item => item.id === 'FR-0042');
    return { record, request: record ? worker.sessions.requests.forSession(record.sessionId) : undefined };
  };
  async function settle(phase) {
    const until = performance.now() + (process.platform === 'win32' ? 150000 : 30000);
    do {
      await workspaceContext(worker).features.tick(true); await worker.board.tick();
      const value = current();
      if (modelFailures.length) throw modelFailures[0];
      if (value.request?.phase === phase && value.record?.result && !worker.sessions.executor.busy && worker.board.active === 0) return value;
      if (value.record?.error) throw Error('Folder intake: ' + value.record.error);
      await delay(20);
    } while (performance.now() < until && !t.signal.aborted);
    assert.fail('Expected phase ' + phase + ': ' + JSON.stringify({ ...current(), folder: workspaceContext(worker).features.view(), tasks: worker.board.view() }));
  }
  async function observe(check) {
    const until = performance.now() + (process.platform === 'win32' ? 150000 : 15000);
    do {
      await workspaceContext(worker).features.tick(true); await worker.board.tick();
      if (modelFailures.length) throw modelFailures[0];
      const value = current(); if (check(value)) return value;
      await delay(20);
    } while (performance.now() < until && !t.signal.aborted);
    assert.fail('Expected source transition: ' + JSON.stringify(current()));
  }
  return { project, intake, before, current, settle, observe, configureChecks, get worker() { return worker; }, get calls() { return calls; }, get networkAttempts() { return networkAttempts; },
    async restart() { await close(); await open(); } };
}

// process.execPath and an ordinary .mjs check use the same argv on Windows and POSIX; no shell fixture or chmod is required.
test('canonical Markdown request delivers a real local candidate, human acceptance and restart without redispatch', { timeout }, async t => {
  const f = await fixture(t);
  const { record, request } = await f.settle('review');
  assert.equal(f.calls, 1); assert.equal(record.id, 'FR-0042'); assert.match(record.taskId, /^feature-[a-f0-9]{40}$/);
  const task = f.worker.board.executionDetail(record.taskId), review = request.delivery.review;
  assert.ok(task.worktreeIdentity); assert.notEqual(task.worktree, f.project); assert.equal(task.baseCommit, f.before.head);
  assert.equal(await readFile(join(task.worktree, 'src', 'value.mjs'), 'utf8'), source);
  assert.equal(await readFile(join(f.project, 'src', 'value.mjs'), 'utf8'), 'export const value = 1;\n');
  assert.equal(task.developmentEvidence.checks[0].exitCode, 0); assert.equal(task.developmentEvidence.checks[0].status, 'passed');
  assert.equal(review.publication, 'local_only'); assert.equal(review.candidate.baseline, f.before.head);
  assert.equal(git(f.project, 'rev-parse', review.candidate.candidateCommit + '^{tree}'), review.candidate.tree);
  assert.equal(git(f.project, 'show', review.candidate.candidateCommit + ':src/value.mjs'), source.trim());
  assert.equal(git(f.project, 'rev-parse', 'refs/heads/' + review.candidate.branch), review.candidate.candidateCommit);
  assert.equal(relative(f.project, review.reviewNotePath).split(/[\\/]/)[0], 'feature-reviews');
  assert.equal(await readFile(review.reviewNotePath, 'utf8'), review.markdown);
  assert.match(await readFile(join(f.intake, record.result), 'utf8'), new RegExp(review.candidate.candidateCommit));
  assert.equal(request.attestation, null, 'A fixture model completion cannot supply human acceptance.');
  const executionEvents = f.worker.sessions.requests.events(request.id).events;
  await f.restart(); await f.settle('review');
  assert.equal(f.calls, 1, 'Review recovery never executes the model again.');
  assert.deepEqual(f.worker.sessions.requests.get(request.id).delivery.review, review);
  assert.deepEqual(f.worker.sessions.requests.events(request.id).events, executionEvents, 'Observing review after restart is journal-idempotent.');
  const parsed = parseFeature(await readFile(join(f.intake, record.name), 'utf8'));
  parsed.document.set('review', { command_id: 'CMD-accept-1', decision: 'accept', request_revision: request.inputRevision,
    candidate_commit: review.candidate.candidateCommit, human_checks: review.criteria.filter(item => item.evaluator === 'human').map(item => ({
      criterion_id: item.id, outcome: 'pass', note: 'Inspected the exact candidate source and preserved user checkout; the visible value is two.',
    })) });
  await writeFile(join(f.intake, record.name), '---\n' + parsed.document.toString({ lineWidth: 0 }) + '---\n' + parsed.body);
  const accepted = await f.settle('done');
  assert.equal(accepted.request.attestation.actor, 'operator'); assert.equal(accepted.request.attestation.inputHash, request.inputHash);
  assert.equal(accepted.record.commandReceipts.find(item => item.commandId === 'CMD-accept-1').outcome, 'accepted');
  const acceptedEvents = f.worker.sessions.requests.events(request.id).events;
  await f.restart(); await f.settle('done');
  assert.equal(f.calls, 1); assert.equal(f.networkAttempts, 0);
  assert.deepEqual(f.worker.sessions.requests.events(request.id).events, acceptedEvents, 'Saved Markdown review commands do not append duplicate acceptance after restart.');
  assert.equal(git(f.project, 'remote'), ''); assert.equal(git(f.project, 'branch', '--show-current'), 'main');
  assert.equal(git(f.project, 'rev-parse', 'HEAD'), f.before.head); assert.equal(git(f.project, 'write-tree'), f.before.index);
  assert.equal(git(f.project, 'diff', '--cached'), f.before.staged); assert.equal(git(f.project, 'diff'), f.before.unstaged);
  assert.equal(await readFile(join(f.project, 'private-untracked.txt'), 'utf8'), 'retain this local work\n');
});


async function editRequest(f, edit) {
  const file = join(f.intake, 'FR-0042.md'), parsed = parseFeature(await readFile(file, 'utf8'));
  edit(parsed);
  await writeFile(file, '---\n' + parsed.document.toString({ lineWidth: 0 }) + '---\n' + parsed.body);
}

test('priority-only Markdown edits reorder a paused queue without accepting another input or invoking a model', { timeout }, async t => {
  const f = await fixture(t, { paused: true });
  const initial = await f.observe(value => !!value.request);
  assert.equal(f.calls, 0); assert.equal(f.worker.board.detail(initial.record.taskId).priority, 1);
  await editRequest(f, parsed => parsed.document.set('priority', 'urgent'));
  const updated = await f.observe(value => value.record && f.worker.board.detail(value.record.taskId).priority === 3);
  assert.equal(updated.request.id, initial.request.id); assert.equal(updated.request.inputRevision, initial.request.inputRevision);
  assert.equal(updated.record.inputHash, initial.record.inputHash); assert.equal(f.calls, 0);
  await f.worker.updateSettings({ board: { paused: false } }); await f.settle('review');
  assert.equal(f.calls, 1);
});

test('removing acceptance criteria from canonical Markdown clears stale criteria and blocks the same request at readiness', { timeout }, async t => {
  const f = await fixture(t), initial = await f.settle('review');
  const historicalPath = join(f.intake, initial.record.execution.result), historical = await readFile(historicalPath, 'utf8');
  await editRequest(f, parsed => { parsed.body = parsed.body.replace(/## Acceptance criteria\n[\s\S]*?(?=## Boundaries)/, ''); });
  const revised = await f.observe(value => value.request?.inputRevision > initial.request.inputRevision);
  assert.equal(revised.request.id, initial.request.id); assert.deepEqual(revised.request.input.criteria, []);
  const ready = revised.request.evaluations.findLast(item => item.stage === 'ready' && item.inputRevision === revised.request.inputRevision);
  assert.equal(ready.passed, false); assert.equal(revised.request.execution, null); assert.equal(f.calls, 1);
  assert.equal(revised.request.attestation, null);
  assert.equal(revised.request.deliveryHistory.at(-1).review.candidate.candidateCommit, initial.request.delivery.review.candidate.candidateCommit);
  assert.notEqual(revised.request.phase, 'review');
  assert.equal(workspaceContext(f.worker).features.view().error, null); assert.equal(revised.record.result, undefined);
  assert.equal(await readFile(historicalPath, 'utf8'), historical, 'Prior generation review remains immutable while the new generation waits.');
});

test('an external candidate edit withdraws review readiness without another model call or stale acceptance', { timeout }, async t => {
  const f = await fixture(t), initial = await f.settle('review');
  const task = f.worker.board.executionDetail(initial.record.taskId), review = initial.request.delivery.review;
  await writeFile(join(task.worktree, 'src', 'value.mjs'), 'export const value = 3;\n');
  const changed = await f.observe(value => value.request?.delivery?.holds.some(hold => hold.code === 'candidate_changed'));
  assert.equal(changed.request.phase, 'needs_rework'); assert.equal(f.calls, 1);
  assert.equal(changed.request.delivery.review.candidate.candidateCommit, review.candidate.candidateCommit);
  await assert.rejects(f.worker.requestCommand({ action: 'attest', requestId: changed.request.id, expectedRevision: changed.request.revision,
    operationId: 'reject-stale-candidate', inputRevision: changed.request.inputRevision, inputHash: changed.request.inputHash,
    candidateCommit: review.candidate.candidateCommit, candidateDigest: review.candidate.candidateDigest,
    outputDigest: initial.request.execution.outputDigest, note: 'This earlier result must not be accepted.',
    humanOutcomes: review.criteria.filter(item => item.evaluator === 'human').map(item => ({ criterionId: item.id, outcome: 'passed', reason: 'An earlier human observation.' })) }), /candidate|review|changed/i);
  assert.equal(f.worker.sessions.requests.get(changed.request.id).attestation, null); assert.equal(f.calls, 1);
});


test('an exact-file canonical request waits for a required check and retries the same source once configured', { timeout }, async t => {
  const f = await fixture(t, { requiredCheck: false, exactFile: true });
  const blocked = await f.observe(value => !!value.record?.error);
  assert.match(blocked.record.error, /Local delivery requires.*required verification check/);
  assert.match(blocked.record.error, /Settings.*retry this Feature Request/);
  assert.equal(blocked.record.submitted, false); assert.equal(blocked.record.status, 'waiting');
  assert.equal(taskboardRuntime(f.worker.board).tasks.length, 0); assert.equal(f.calls, 0);
  assert.equal(parseFeature(await readFile(join(f.intake, blocked.record.name), 'utf8')).data.id, 'FR-0042');
  await f.worker.updateSettings({ board: { paused: true } });
  await f.configureChecks(true);
  await f.worker.updateSettings({ board: { paused: false } });
  const admitted = await f.settle('review');
  assert.equal(admitted.record.id, blocked.record.id); assert.equal(admitted.record.taskId, blocked.record.taskId);
  assert.equal(admitted.record.inputHash, blocked.record.inputHash); assert.equal(admitted.record.semanticRevision, 1);
  assert.equal(admitted.request.inputRevision, 1); assert.equal(f.calls, 1);
  assert.equal(admitted.request.delivery.review.checks[0].status, 'passed');
  assert.equal(git(f.project, 'rev-parse', 'HEAD'), f.before.head); assert.equal(git(f.project, 'write-tree'), f.before.index);
});
