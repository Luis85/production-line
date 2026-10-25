import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { workspaceModelFactory } from '../../src/worker/dist/worker/infrastructure/workspace-services.js';
import { defaultDeliveryProjectPolicy } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { defaultFeatureWorkflow, defaultFeatureCheck } from '../../src/worker/dist/worker/application/feature-workflow.js';
import { authoringTemplateFor } from '../../src/worker/dist/worker/infrastructure/feature-authoring-assets.js';
import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';
import { parseFeature } from '../../src/worker/dist/worker/infrastructure/features/document.js';
import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import { taskboardRuntime, workspaceContext, reviewOptions } from './runtime-fixtures.mjs';
import { workerStatus } from '../helpers/worker-status.mjs';

prepareNativeProcessFixture();
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();

/** Only provider inference is simulated: registration, Git CAS, candidate tools, checks, review note and restart are real. */
for (const bootstrap of [false, true]) test('plain Git managed shared workflow publishes one verified feature branch and PullRequest Markdown without GitHub' + (bootstrap ? ' with the new web setup readiness profile' : ''), { timeout: process.platform === 'win32' ? 300000 : 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'werk-plain-git-')), producer = join(root, 'producer'), remote = join(root, 'company.git'), state = join(root, 'state');
  await mkdir(producer); git(root, 'init', '--bare', '--initial-branch=main', remote); git(producer, 'init', '--initial-branch=main'); git(producer, 'remote', 'add', 'origin', remote);
  const workflow = defaultFeatureWorkflow(), policy = defaultDeliveryProjectPolicy();
  const files = { '.gitattributes': '* text eol=lf\n', '.werk/feature-workflow.json': JSON.stringify(workflow), '.werk/delivery-policy.json': JSON.stringify(policy),
    [workflow.template]: authoringTemplateFor('claude-cli'), [workflow.base]: 'views: []\n',
    [workflow.readyCheck]: JSON.stringify(defaultFeatureCheck('ready')), [workflow.doneCheck]: JSON.stringify(defaultFeatureCheck('done')),
    'src/value.mjs': 'export const value = 1;\n', 'tests/value.mjs': "import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; assert.equal(value, 2); console.log('fixture-private-check-output');\n" };
  if (bootstrap) for (const path of Object.keys(files)) if (!['.gitattributes', 'src/value.mjs', 'tests/value.mjs'].includes(path)) delete files[path];
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(producer, path)), { recursive: true }); await writeFile(join(producer, path), content); }
  git(producer, 'add', '.'); git(producer, 'commit', '-m', 'Plain Git workflow with no GitHub integration'); git(producer, 'push', 'origin', 'main');

  let calls = 0, githubCalls = 0, httpCalls = 0, advisoryCalls = 0;
  const failures = [], originalSpawn = childProcess.spawn;
  const spawn = t.mock.method(childProcess, 'spawn', function (executable, args, options) {
    let invoked = executable;
    if (options?.env?.WERK_PROVIDER_LAUNCH) invoked = JSON.parse(Buffer.from(options.env.WERK_PROVIDER_LAUNCH, 'base64').toString('utf8')).executable;
    else if (Array.isArray(args) && args[0] === 'werk-supervisor-v1' && args[1] === 'argv') invoked = args[2];
    if (/^gh(?:\.exe)?$/i.test(basename(invoked))) { githubCalls++; throw Error('Plain Git must never launch GitHub CLI.'); }
    return Reflect.apply(originalSpawn, this, [executable, args, options]);
  });
  syncBuiltinESMExports();
  t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
  t.mock.method(globalThis, 'fetch', async () => { httpCalls++; throw Error('Plain Git acceptance must not call an HTTP API.'); });
  /** @type {import('../../src/worker/infrastructure/workspace-services.js').WorkspaceProviderFactory} */
  const fixtureModel = (connection, _directory, _transport, options) => ({
    configuration: { id: connection.id, model: connection.model, authenticationMode: connection.authenticationMode, instruction: '' }, capabilities: modelCapabilities,
    get toolManifest() { return options.tools().manifest; }, toolManifestFor(scope) { return options.tools(scope).manifest; },
    async reply() { throw Error('Expected typed fixture inference.'); },
    async execute(dispatch, signal) {
      calls++; const tools = options.tools(dispatch.policy);
      try {
        assert.equal(dispatch.provider.id, 'claude-cli'); assert.equal(dispatch.policy.development, true);
        const observed = await tools.call('werk_candidate_status', {}, signal); assert.notEqual(observed.isError, true);
        const candidate = JSON.parse(observed.content.map(item => item.text).join('\n'));
        const file = candidate.files.find(item => item.path === 'src/value.mjs'); assert.ok(file?.hash);
        const changed = await tools.call('werk_candidate_apply', { path: 'src/value.mjs', content: 'export const value = 2;\n', expectedHash: file.hash }, signal);
        assert.notEqual(changed.isError, true); return { type: 'completed', text: 'Fixture inference changed the approved value; the worker independently runs committed checks before publishing review evidence.' };
      } catch (error) { failures.push(error); throw error; } finally { await tools.close(); }
    },
  });
  /** @type {WorkerWorkspace | undefined} */
  let activeWorker;
  /** @type {SnapshotJournal | undefined} */
  let journal;
  async function open() {
    journal = new SnapshotJournal(state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
    const current = new WorkerWorkspace({ stateDir: state, projectDir: root, pollMs: 1000, timeoutMs: 60000 }, journal, workerStatus);
    const context = workspaceContext(current);
    taskboardRuntime(current.board).model = workspaceModelFactory(context.config.stateDir, current.settings, fixtureModel, current.consumption, current.sessions.runs, { supervisor: () => context.processes, observations: context.processObservations });
    reviewOptions(current.reviews).model = profile => ({ configuration: profile, capabilities: modelCapabilities, async reply() { throw Error('Expected typed fixture assessment.'); }, async execute(dispatch) {
      advisoryCalls++;
      const ready = dispatch.messages.some(message => message.text.includes('\"stage\":\"ready\"'));
      return { type: 'completed', text: JSON.stringify({ schemaVersion: 1, findings: [], ...(ready ? { readiness: { conditions: ['outcome', 'criteria', 'scope'].map(id => ({ id, outcome: 'pass', reason: 'Explicit bounded source and independent committed checks.' })), estimatedMinutes: 5, proposals: [] } } : {}) }) };
    } });
    activeWorker = current; await current.init(); return current;
  }
  async function close() { await activeWorker?.close(); journal?.close(); }
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  let worker = await open();
  await worker.updateSettings({ defaultProvider: 'claude-cli', provider: { id: 'claude-cli', authenticationMode: 'cli-account', executable: process.execPath, model: 'fixture-inference-only' }, board: { paused: true } });
  const registered = await worker.managedProjectCommand({ action: 'register', operationId: 'plain-register', id: 'plain', repository: pathToFileURL(remote).toString() });
  assert.equal(registered.projects[0].status, 'ready'); assert.equal(registered.projects[0].intakeEnabled, false);
  const checkout = registered.projects[0].path;
  if (bootstrap) {
    const setup = await worker.managedProjectCommand({ action: 'setup_plan', id: 'plain', provider: 'claude-cli' });
    const installed = await worker.managedProjectCommand({ action: 'setup_apply', id: 'plain', operationId: 'plain-web-workflow', expectedPlan: setup.planDigest });
    assert.equal(installed.status, 'published');
  }
  const checkoutBaseline = git(checkout, 'rev-parse', 'HEAD');
  const committedPolicy = await worker.requestCommand({ action: 'delivery_policy', projectId: 'plain' });
  assert.ok('configurationDigest' in committedPolicy && 'approvalRevision' in committedPolicy);
  assert.equal(committedPolicy.configuration.remoteDelivery, undefined); assert.equal(committedPolicy.configuration.release, undefined);
  await worker.requestCommand({ action: 'approve_delivery_policy', repositoryId: 'plain', configurationDigest: committedPolicy.configurationDigest, expectedApprovalRevision: committedPolicy.approvalRevision });
  const enabled = await worker.managedProjectCommand({ action: 'reconcile', operationId: 'plain-enable', id: 'plain' });
  assert.equal(enabled.projects[0].intakeEnabled, true);
  const github = enabled.diagnostics.find(item => item.id === 'github'); assert.equal(github.required, false); assert.equal(github.applicable, false);
  const grant = worker.settings.toolPolicy();
  await worker.updateToolAccess({ expectedRevision: grant.revision, builtins: { ...grant.builtins, files: true, commands: [{ id: 'plain-check', name: 'Verify actual exported value', executable: process.execPath, args: ['tests/value.mjs'], enabled: true, verification: true }] }, mcp: [] });
  const draft = await worker.featureCommand({ action: 'prepare', projectId: 'plain', operationId: 'plain-draft', seed: { title: 'Plain Git value change', provider: 'claude-cli', message: 'Change the exported value to two within the approved candidate.', paths: ['src/value.mjs'] } });
  const markdown = draft.markdown
    .replace('<!-- Describe constraints, relevant behavior, and what is outside this request. -->', 'Preserve unrelated source and the committed verification definition.')
    .replace('<!-- Add one or more concrete, verifiable checklist items. -->', '- The exported value is two and the committed verification passes.')
    .replace('<!-- Explain how each outcome will be checked and what evidence reviewers need. -->', 'Run the committed value test against the isolated candidate.');
  /** @type {import('../../src/worker/application/feature-authoring-contracts.ts').FeatureAuthoringCommand} */
  const command = { action: 'publish', projectId: 'plain', operationId: 'plain-ready', name: draft.name, markdown, status: 'ready', expectedRevision: draft.revision, expectedWorkflowDigest: draft.workflowDigest, expectedBinding: draft.binding };
  const ready = await worker.featureCommand(command);
  assert.ok(ready.publication?.commit); assert.equal(calls, 0, 'The request is committed and pushed before provider dispatch.');
  assert.equal(parseFeature(git(remote, 'show', 'main:' + ready.path)).data.status, 'ready');
  await worker.updateSettings({ board: { paused: false } });
  const until = performance.now() + (process.platform === 'win32' ? 210000 : 60000);
  let record;
  while (performance.now() < until) {
    await worker.sharedIntakeCommand({ action: 'sync', projectId: 'plain' }); await worker.board.tick();
    if (failures.length) throw failures[0];
    record = worker.sharedIntakeView('plain').requests.find(item => item.id === ready.featureId);
    assert.equal(record?.error ?? null, null);
    if (record?.status === 'ready_for_review' && record.publication === 'synced' && worker.board.active === 0) break;
    await delay(20);
  }
  assert.equal(record?.status, 'ready_for_review', JSON.stringify(worker.sharedIntakeView('plain')));
  assert.ok(record?.taskId && record.featureBranch && record.reviewNote);
  assert.equal(record.publication, 'synced'); assert.equal(calls, 1); assert.ok(record.featureBranch); assert.ok(record.reviewNote);
  const task = worker.board.executionDetail(record.taskId); assert.ok(task.developmentEvidence && task.requestId);
  const check = task.developmentEvidence.checks.find(item => item.presetId === 'plain-check'); assert.ok(check);
  assert.equal(check.status, 'passed'); assert.equal(check.exitCode, 0); assert.equal(check.candidateDigest, task.developmentEvidence.candidateDigest);
  const branchCommit = git(remote, 'rev-parse', 'refs/heads/' + record.featureBranch), review = git(remote, 'show', 'main:' + record.reviewNote), note = parseFeature(review);
  const request = worker.sessions.requests.get(task.requestId);
  assert.equal(note.data.policyDigest, request.policyDigest);
  if (bootstrap) {
    assert.ok(advisoryCalls > 0, 'The new profile requires a structured readiness assessment.');
    const runtime = workspaceContext(worker).featureProjects.resolve('plain');
    const retained = JSON.parse(await readFile(join(runtime.stateDirectory, 'shared-intake.json'), 'utf8')).records.find(item => item.id === ready.featureId);
    assert.equal(git(checkout, 'status', '--porcelain'), '', 'Private delivery packaging must leave the assigned main checkout clean.');
    assert.ok(request.delivery?.review?.reviewNotePath);
    const privatePath = relative(workspaceContext(worker).config.stateDir, request.delivery.review.reviewNotePath);
    assert.ok(!privatePath.startsWith('..') && !isAbsolute(privatePath), 'Shared delivery packaging retains its local artifact in the private worker ledger.');
    assert.equal(await readFile(request.delivery.review.reviewNotePath, 'utf8'), request.delivery.review.markdown);
    assert.ok(retained.executionPolicy); assert.notEqual(retained.workflow.policyDigest, request.policyDigest); assert.equal(note.data.workflowPolicyDigest, retained.workflow.policyDigest);
  }
  assert.equal(note.data.type, 'PullRequest'); assert.equal(note.data.featureId, ready.featureId); assert.equal(note.data.featureCommit, branchCommit);
  assert.equal(git(remote, 'show', branchCommit + ':src/value.mjs'), 'export const value = 2;');
  assert.equal(git(remote, 'show', 'main:src/value.mjs'), 'export const value = 1;', 'Shared review publication cannot merge implementation into main.');
  assert.ok(review.includes(check.candidateDigest)); assert.match(review, /Required checks passed for this candidate/); assert.match(review, /Verify actual exported value.*passed/);
  assert.doesNotMatch(review, /fixture-private-check-output/); assert.equal(worker.sessions.requests.get(task.requestId).delivery?.publications?.length ?? 0, 0);
  assert.equal(await readFile(join(checkout, 'src/value.mjs'), 'utf8'), 'export const value = 1;\n'); assert.equal(git(checkout, 'rev-parse', 'HEAD'), checkoutBaseline);
  const sharedHead = git(remote, 'rev-parse', 'main'), branches = git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads');
  await close(); worker = await open();
  await worker.sharedIntakeCommand({ action: 'sync', projectId: 'plain' }); await worker.sharedIntakeCommand({ action: 'sync', projectId: 'plain' }); await worker.board.tick();
  const recovered = worker.sharedIntakeView('plain').requests.find(item => item.id === ready.featureId);
  assert.ok(recovered);
  assert.equal(recovered.taskId, record.taskId); assert.equal(recovered.featureBranch, record.featureBranch); assert.equal(recovered.reviewNote, record.reviewNote);
  assert.equal(recovered.status, 'ready_for_review'); assert.equal(recovered.publication, 'synced'); assert.equal(calls, 1, 'Restart must not redispatch inference or create another handoff.');
  assert.equal(git(remote, 'rev-parse', 'main'), sharedHead); assert.equal(git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads'), branches);
  assert.equal(git(remote, 'show', 'main:' + record.reviewNote), review); assert.equal(githubCalls, 0); assert.equal(httpCalls, 0);
  if (bootstrap) {
    let current = worker.sessions.requests.get(task.requestId); assert.ok(current.delivery?.review && current.execution?.outputDigest);
    const candidate = current.delivery.review.candidate;
    await worker.requestCommand({ action: 'attest', requestId: current.id, expectedRevision: current.revision, operationId: 'plain-reviewed-acceptance', note: 'Inspected the exact candidate and its actual committed value check.', inputRevision: current.inputRevision, inputHash: current.inputHash, outputDigest: current.execution.outputDigest, candidateCommit: candidate.candidateCommit, candidateDigest: candidate.candidateDigest, humanOutcomes: current.delivery.review.criteria.filter(item => item.evaluator === 'human').map(item => ({ criterionId: item.id, outcome: 'passed', reason: 'Checked the exact value change and verified its committed check.' })) });
    const mergeView = await worker.requestCommand({ action: 'local_merge', requestId: current.id });
    assert.ok('canMerge' in mergeView && mergeView.canMerge && mergeView.target && 'checkoutPath' in mergeView.target, JSON.stringify(mergeView));
    current = worker.sessions.requests.get(current.id);
    await worker.requestCommand({ action: 'merge_local_candidate', requestId: current.id, expectedRevision: current.revision, operationId: 'plain-approved-main-merge', deliveryRunId: candidate.runId, inputRevision: current.inputRevision, candidateCommit: candidate.candidateCommit, candidateDigest: candidate.candidateDigest, mainCheckout: mergeView.target.checkoutPath, mainBranch: mergeView.target.branch, mainHead: mergeView.target.head });
    const merged = worker.sessions.requests.get(current.id).delivery?.localMerge?.merged; assert.ok(merged);
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), merged.mergeCommit); assert.equal(await readFile(join(checkout, 'src/value.mjs'), 'utf8'), 'export const value = 2;\n');
    assert.equal(git(checkout, 'status', '--porcelain'), ''); assert.equal(git(remote, 'show', 'main:src/value.mjs'), 'export const value = 1;', 'The explicit local merge must not push main.');
    assert.equal(githubCalls, 0); assert.equal(httpCalls, 0); assert.equal(calls, 1);
  }
});
