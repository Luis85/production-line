import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { workspaceModelFactory } from '../../src/worker/dist/worker/infrastructure/workspace-services.js';
import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';
import { defaultDeliveryProjectPolicy } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { featureDeliverySubmission } from '../../src/worker/dist/worker/status/workspace-delivery.js';
import { parseFeature } from '../../src/worker/dist/worker/infrastructure/features/document.js';
import { workerStatus } from '../helpers/worker-status.mjs';
import { taskboardRuntime, workspaceContext } from './runtime-fixtures.mjs';

prepareNativeProcessFixture();

const timeout = process.platform === 'win32' ? 300000 : 120000;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
const note = (id, extra = '') => `---
schema: worker.request/v1
id: ${id}
title: Deliver a project-scoped value change
intent: submit
mode: patch
paths: [src/]
priority: normal
${extra}---
# Deliver a project-scoped value change

## Outcome

Change the exported value to two inside this project's candidate, preserving developer work.

## Acceptance criteria

- AC-01: The exported value is two after the committed verification passes.

## Boundaries

Only src is approved. Keep the committed check unchanged.
`;

/** Real repositories, journals, worktrees and checks; only the model execution port is injected. */
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk-multi-'))), state = join(root, 'state');
  const projects = { alpha: join(root, 'alpha'), beta: join(root, 'beta') };
  const policy = defaultDeliveryProjectPolicy();
  policy.execution = { defaultProfile: 'implementation', allowedOverrides: ['alternative'], fallbackProfiles: [], fallbackOn: [], maxHandoffs: 0,
    profiles: ['implementation', 'alternative'].map(id => ({ id, provider: 'openai-api', model: 'fixture-' + id, effort: 'default', authenticationMode: 'api-key', boundary: 'worker_grants' })) };
  for (const path of Object.values(projects)) {
    await mkdir(join(path, 'src'), { recursive: true }); await mkdir(join(path, 'tests')); await mkdir(join(path, '.werk')); await mkdir(join(path, 'features'));
    git(path, 'init', '--initial-branch=main'); git(path, 'config', 'user.name', 'Werk Fixture'); git(path, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(path, 'src', 'value.mjs'), 'export const value = 1;\n');
    await writeFile(join(path, 'tests', 'value.mjs'), "import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; assert.equal(value, 2);\n");
    await writeFile(join(path, '.werk', 'delivery-policy.json'), JSON.stringify(policy)); git(path, 'add', '.'); git(path, 'commit', '-m', 'Trusted project baseline');
  }
  const calls = [], failures = [];
  /** @type {WorkerWorkspace | undefined} */ let worker;
  /** @type {SnapshotJournal | undefined} */ let journal;
  /** @type {import('../../src/worker/infrastructure/workspace-services.js').WorkspaceProviderFactory} */
  const factory = (connection, _directory, _transport, options) => ({
    configuration: { id: connection.id, model: connection.model, authenticationMode: connection.authenticationMode, instruction: '' }, capabilities: modelCapabilities,
    get toolManifest() { return options.tools().manifest; }, toolManifestFor(policy) { return options.tools(policy).manifest; },
    async reply() { throw Error('Expected typed model dispatch.'); },
    async execute(dispatch, signal) {
      calls.push({ provider: dispatch.provider.id, model: dispatch.provider.model });
      const tools = options.tools(dispatch.policy);
      try {
        const status = await tools.call('werk_candidate_status', {}, signal); assert.notEqual(status.isError, true, JSON.stringify(status));
        const candidate = JSON.parse(status.content.map(item => item.text).join('\n'));
        const file = candidate.files.find(item => item.path === 'src/value.mjs'); assert.ok(file?.hash);
        const applied = await tools.call('werk_candidate_apply', { path: 'src/value.mjs', content: 'export const value = 2;\n', expectedHash: file.hash }, signal);
        assert.notEqual(applied.isError, true, JSON.stringify(applied));
        return { type: 'completed', text: 'Implemented the approved source change. Verify the committed candidate and await human review.' };
      } catch (error) { failures.push(error); throw error; } finally { await tools.close(); }
    },
  });
  async function open() {
    journal = new SnapshotJournal(state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
    worker = new WorkerWorkspace({ stateDir: state, projectDir: projects.alpha, pollMs: 1000, timeoutMs: 60000 }, journal, workerStatus);
    const context = workspaceContext(worker);
    taskboardRuntime(worker.board).model = workspaceModelFactory(state, worker.settings, factory, worker.consumption, worker.sessions.runs, { supervisor: () => context.processes, observations: context.processObservations });
    await worker.init();
  }
  async function close() { await worker?.close(); worker = undefined; journal?.close(); journal = undefined; }
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  await open();
  await worker.updateSettings({ provider: { id: 'openai-api', authenticationMode: 'api-key', apiKey: 'fixture-never-sent', model: 'mutable-default' }, board: { paused: true } });
  const discovery = worker.repositoryStatus().discovery;
  await worker.repositoryCommand({ action: 'accept', discoveryId: discovery.id });
  await worker.updateSettings({ repositories: { pollMs: 60000, items: Object.entries(projects).map(([id, path]) => ({ id, path, remote: 'origin', watch: false, features: { directory: 'features', pollMs: 1000 } })) } });
  const grant = worker.settings.toolPolicy();
  await worker.updateToolAccess({ expectedRevision: grant.revision, builtins: { ...grant.builtins, files: true, commands: [{ id: 'candidate-check', name: 'Verify candidate value', executable: process.execPath, args: ['tests/value.mjs'], enabled: true, verification: true }] }, mcp: [] });
  const gates = worker.sessions.requests.policy(); gates.policy.reviewer.enabled = false;
  await worker.requestCommand({ action: 'set_policy', expectedRevision: gates.revision, operationId: 'manual-review', policy: gates.policy });
  async function approve(projectId) {
    const view = await worker.requestCommand({ action: 'delivery_policy', projectId });
    assert.ok('configurationDigest' in view && 'approvalRevision' in view);
    await worker.requestCommand({ action: 'approve_delivery_policy', repositoryId: projectId, configurationDigest: view.configurationDigest, expectedApprovalRevision: view.approvalRevision });
  }
  const current = (projectId, id = 'FR-0001') => {
    const record = workspaceContext(worker).featureProjects.resolve(projectId).features.view().records.find(item => item.id === id);
    return { record, request: record ? worker.sessions.requests.forSession(record.sessionId) : undefined };
  };
  async function observe(check) {
    const until = performance.now() + (process.platform === 'win32' ? 210000 : 60000);
    do { await worker.tickFeatures(true); await worker.board.tick(); if (failures.length) throw failures[0]; if (check()) return; await delay(20); }
    while (performance.now() < until && !t.signal.aborted);
    assert.fail('Project transition did not settle: ' + JSON.stringify(workspaceContext(worker).featureProjects.all().map(project => project.features?.view())));
  }
  async function accept(projectId, id = 'FR-0001') {
    const { record, request } = current(projectId, id), review = request.delivery.review;
    const file = join(projects[projectId], 'features', record.name), parsed = parseFeature(await readFile(file, 'utf8'));
    parsed.document.set('review', { command_id: 'accept-' + projectId + '-' + id, decision: 'accept', request_revision: request.inputRevision, candidate_commit: review.candidate.candidateCommit,
      human_checks: review.criteria.filter(item => item.evaluator === 'human').map(item => ({ criterion_id: item.id, outcome: 'pass', note: 'Inspected the exact project candidate and verification evidence.' })) });
    await writeFile(file, '---\n' + parsed.document.toString({ lineWidth: 0 }) + '---\n' + parsed.body);
    await observe(() => current(projectId, id).request?.phase === 'done');
  }
  return { projects, policy, calls, approve, current, observe, accept, get worker() { return worker; }, async restart() { await close(); await open(); } };
}

test('two project intakes keep identical FR IDs isolated and freeze approved profile routing across restart', { timeout }, async t => {
  const f = await fixture(t);
  for (const project of Object.values(f.projects)) await writeFile(join(project, 'features', 'FR-0001.md'), note('FR-0001'));
  await f.worker.tickFeatures(true); await f.worker.tickFeatures(true);
  assert.equal(f.calls.length, 0);
  const view = f.worker.featureView('alpha'); assert.ok('errors' in view);
  assert.ok(view.errors.some(error => /approval/.test(error.message)));
  assert.equal(f.current('alpha').record, undefined, 'Repository policy cannot authorize itself.');
  await f.approve('alpha'); await f.approve('beta');
  await f.observe(() => !!f.current('alpha').request && !!f.current('beta').request);
  const alpha = f.current('alpha'), beta = f.current('beta');
  assert.notEqual(alpha.record.taskId, beta.record.taskId); assert.notEqual(alpha.record.sessionId, beta.record.sessionId);
  assert.partialDeepStrictEqual(alpha.request.input.context, { repositoryId: 'alpha', deliveryExecution: { resolution: { source: 'default' } } });
  assert.partialDeepStrictEqual(beta.request.input.context, { repositoryId: 'beta' });
  assert.equal(f.worker.board.executionDetail(alpha.record.taskId).deliveryExecution.profileSnapshots.length, 2);
  const changed = structuredClone(f.policy); changed.execution.profiles[0].model = 'changed-after-reservation';
  await writeFile(join(f.projects.alpha, '.werk', 'delivery-policy.json'), JSON.stringify(changed)); git(f.projects.alpha, 'add', '.werk/delivery-policy.json'); git(f.projects.alpha, 'commit', '-m', 'Different future profile policy');
  await f.restart();
  assert.equal(f.current('alpha').record.taskId, alpha.record.taskId); assert.equal(f.current('beta').record.taskId, beta.record.taskId);
  await f.worker.updateSettings({ board: { paused: false } });
  await f.observe(() => f.current('alpha').request?.phase === 'review' && f.current('beta').request?.phase === 'review' && !f.worker.sessions.executor.busy);
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.model === 'fixture-implementation'));
  for (const projectId of ['alpha', 'beta']) {
    const { record, request } = f.current(projectId), task = f.worker.board.executionDetail(record.taskId);
    assert.notEqual(task.worktree, f.projects[projectId]); assert.equal(task.repository, f.projects[projectId]);
    assert.equal(await readFile(join(task.worktree, 'src/value.mjs'), 'utf8'), 'export const value = 2;\n');
    assert.equal(await readFile(join(f.projects[projectId], 'src/value.mjs'), 'utf8'), 'export const value = 1;\n');
    assert.match(request.delivery.review.reviewNotePath, /feature-reviews/); assert.equal(git(f.projects[projectId], 'remote'), '');
  }
});

test('cross-project dependencies require human acceptance and incorporation in the predecessor repository', { timeout }, async t => {
  const f = await fixture(t); await f.approve('alpha'); await f.approve('beta');
  await writeFile(join(f.projects.alpha, 'features', 'FR-0001.md'), note('FR-0001'));
  await writeFile(join(f.projects.beta, 'features', 'FR-0002.md'), note('FR-0002', 'depends_on: [alpha:FR-0001]\n'));
  await f.worker.updateSettings({ board: { paused: false } });
  await f.observe(() => f.current('alpha').request?.phase === 'review' && !!f.current('beta', 'FR-0002').record?.error);
  assert.equal(f.calls.length, 1);
  const waiting = await f.worker.featureCommand({ action: 'dependency_plan', projectId: 'beta', id: 'FR-0002' });
  assert.equal(waiting.ready, false); assert.ok(waiting.blockers.some(item => item.nodeId === 'alpha:FR-0001' && item.code === 'unaccepted'));
  await f.accept('alpha');
  const accepted = f.current('alpha').request.delivery.review.candidate.candidateCommit;
  const unmerged = await f.worker.featureCommand({ action: 'dependency_plan', projectId: 'beta', id: 'FR-0002' });
  assert.equal(unmerged.ready, false); assert.ok(unmerged.blockers.some(item => item.code === 'not_integrated'));
  assert.equal(f.calls.length, 1, 'Acceptance alone cannot start a code-dependent request.');
  git(f.projects.alpha, 'merge', '--ff-only', accepted);
  const integrated = await f.worker.featureCommand({ action: 'dependency_plan', projectId: 'beta', id: 'FR-0002' });
  assert.equal(integrated.ready, true);
  const receipt = integrated.nodes.find(item => item.id === 'alpha:FR-0001').receipt;
  assert.equal(receipt.repositoryId, 'alpha'); assert.equal(receipt.integrationBaseline, accepted); assert.notEqual(receipt.baseline, receipt.integrationBaseline);
  await f.observe(() => f.current('beta', 'FR-0002').request?.phase === 'review' && !f.worker.sessions.executor.busy);
  assert.equal(f.calls.length, 2);
  const delivered = f.current('beta', 'FR-0002');
  const dependency = f.worker.board.executionDetail(delivered.record.taskId).dependencies[0];
  assert.partialDeepStrictEqual(delivered.request.input.context, { dependencies: [dependency] });
  assert.equal(dependency.id, 'alpha:FR-0001'); assert.equal(dependency.integrationBaseline, accepted);
  assert.equal(git(f.projects.beta, 'show', 'HEAD:src/value.mjs'), 'export const value = 1;');
});


test('primary intake configuration recovers after an unavailable folder is repaired', { timeout }, async t => {
  const f = await fixture(t), path = join(f.projects.alpha, 'new-intake');
  await writeFile(path, 'This ordinary file cannot be used as an intake folder.');
  const repositories = structuredClone(f.worker.settings.value.repositories);
  repositories.items.find(item => item.id === 'alpha').features.directory = 'new-intake';
  await assert.rejects(f.worker.updateSettings({ repositories }));
  await rm(path); await mkdir(path);
  await f.worker.updateSettings({ repositories });
  const view = f.worker.featureView('alpha'); assert.ok('directory' in view); assert.equal(view.directory, path);
  await f.approve('alpha');
  await writeFile(join(path, 'FR-0001.md'), note('FR-0001'));
  await f.observe(() => !!f.current('alpha').request);
  assert.equal(f.current('alpha').record.id, 'FR-0001'); assert.equal(f.calls.length, 0);
});


test('legacy primary shared binding uses the assigned repository policy without duplicate project ownership', { timeout }, async t => {
  const f = await fixture(t); await f.approve('beta');
  const binding = { enabled: false, repositoryId: 'beta', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 300000 };
  const view = await f.worker.sharedIntakeCommand({ action: 'configure', expectedRevision: 0, config: binding });
  assert.ok('selectedProjectId' in view && 'projects' in view);
  assert.equal(view.selectedProjectId, 'beta'); assert.equal(view.projects.filter(project => project.id === 'beta').length, 1);
  assert.equal(view.projects.find(project => project.id === 'beta').directory, undefined, 'An unread shared workflow must not display the installation project folder.');
  const context = workspaceContext(f.worker), project = context.featureProjects.resolve('beta');
  assert.equal(project.primary, true); assert.equal(context.featureProjects.repository(project), f.projects.beta);
  const snapshot = await f.worker.requestCommand({ action: 'delivery_policy', projectId: 'beta' });
  assert.ok('configurationDigest' in snapshot && 'profile' in snapshot);
  const submission = await featureDeliverySubmission(context, { id: 'FR-0001', input: { title: 'Bound project', mode: 'patch', provider: 'openai-api', message: 'Change only the bound project.', priority: 1 }, deliveryPolicy: snapshot }, f.projects.beta, f.worker.sessions.requests.policy().policy);
  assert.equal(submission.repositoryId, 'beta'); assert.equal(submission.baseCommit, git(f.projects.beta, 'rev-parse', 'HEAD'));
  assert.deepEqual(submission.dependencies, []); assert.equal(f.calls.length, 0);
  await f.restart();
  assert.equal(f.worker.sharedIntakeView().selectedProjectId, 'beta');
  assert.equal(workspaceContext(f.worker).featureProjects.repository(workspaceContext(f.worker).featureProjects.resolve('beta')), f.projects.beta);
});

test('primary shared binding cannot take over another project with retained Feature Requests', { timeout }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.projects.beta, 'features', 'FR-0001.md'), note('FR-0001', 'depends_on: [FR-missing]\n'));
  await f.approve('beta'); await f.worker.tickFeatures(true); await f.worker.tickFeatures(true);
  const retained = f.current('beta').record; assert.ok(retained); assert.equal(f.worker.board.view().tasks.length, 0);
  const binding = { enabled: false, repositoryId: 'beta', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 300000 };
  await assert.rejects(f.worker.sharedIntakeCommand({ action: 'configure', expectedRevision: 0, config: binding }), /already owns retained Feature Requests/);
  assert.equal(f.worker.sharedIntakeView().config.repositoryId, '');
  assert.equal(f.current('beta').record.taskId, retained.taskId); assert.equal(f.calls.length, 0);
  await f.restart();
  assert.equal(f.current('beta').record.taskId, retained.taskId); assert.equal(f.worker.sharedIntakeView().config.repositoryId, '');
});
