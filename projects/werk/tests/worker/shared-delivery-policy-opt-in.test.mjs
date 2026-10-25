import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { workspaceModelFactory } from '../../src/worker/dist/worker/infrastructure/workspace-services.js';
import { defaultDeliveryProjectPolicy } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { defaultFeatureWorkflow, defaultFeatureCheck } from '../../src/worker/dist/worker/application/feature-workflow.js';
import { parseFeature } from '../../src/worker/dist/worker/infrastructure/features/document.js';
import { authoringTemplateFor } from '../../src/worker/dist/worker/infrastructure/feature-authoring-assets.js';
import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';
import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import { taskboardRuntime, workspaceContext } from './runtime-fixtures.mjs';
import { workerStatus } from '../helpers/worker-status.mjs';

prepareNativeProcessFixture();
const timeout = process.platform === 'win32' ? 300000 : 120000;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
const request = `---
schemaVersion: 1
templateId: feature-request-v1
id: shared-release-feature
title: Deliver a release from a shared v1 request
status: ready
mode: patch
provider: claude-cli
paths: [src/value.mjs]
---
# Goal
Change the exported value to two within the approved candidate.
## Context
Preserve unrelated source and the committed verification definition.
## Acceptance criteria
- [ ] The exported value is two and the committed verification passes.
## Verification plan
Run the committed value verification against the isolated candidate.
`;

/** Real shared Git handoff, worker request journal, worktree and checks; only provider inference is a fixture. */
for (const aliased of [false, true]) test('shared v1 release policy without named execution profiles freezes delivery and produces a verified release candidate' + (aliased ? ' through a host state-parent alias' : ''), { timeout }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'werk-shared-release-policy-')), producer = join(root, 'producer'), remote = join(root, 'remote.git'), repository = join(root, 'worker');
  let state = join(root, 'state');
  if (aliased) {
    const parent = join(root, 'state-parent'), alias = join(root, 'host-alias'); await mkdir(parent);
    try { await symlink(parent, alias, 'junction'); }
    catch (error) { await rm(root, { recursive: true, force: true }); if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('This host does not permit directory aliases.'); return; } throw error; }
    state = join(alias, 'state');
  }
  await mkdir(producer); git(root, 'init', '--bare', '--initial-branch=main', remote); git(producer, 'init', '--initial-branch=main'); git(producer, 'remote', 'add', 'origin', remote);
  const configuration = defaultFeatureWorkflow(), policy = defaultDeliveryProjectPolicy();
  policy.remoteDelivery = { remote: 'origin', repository: 'example/sample', base: 'main', push: true, pullRequest: true, draft: false };
  policy.release = { repository: 'example/sample', base: 'main', mergeMethod: 'squash', tagPrefix: 'v', prerelease: true,
    build: { executable: process.execPath, args: ['scripts/release.mjs'], timeoutMs: 10000, artifacts: ['out/build.txt'] } };
  policy.startPromptDirectory = 'prompt-ledger';
  const files = { '.gitattributes': '* text eol=lf\n', '.werk/feature-workflow.json': JSON.stringify(configuration), '.werk/delivery-policy.json': JSON.stringify(policy),
    [configuration.template]: authoringTemplateFor('claude-cli'), [configuration.base]: 'views: []\n',
    [configuration.readyCheck]: JSON.stringify(defaultFeatureCheck('ready')), [configuration.doneCheck]: JSON.stringify(defaultFeatureCheck('done')),
    'src/value.mjs': 'export const value = 1;\n', 'tests/value.mjs': "import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; assert.equal(value, 2);\n" };
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(producer, path)), { recursive: true }); await writeFile(join(producer, path), content); }
  git(producer, 'add', '.'); git(producer, 'commit', '-m', 'Approved project workflow'); git(producer, 'push', 'origin', 'main'); git(root, 'clone', '--', remote, repository);
  const journal = new SnapshotJournal(state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
  const worker = new WorkerWorkspace({ stateDir: state, projectDir: repository, pollMs: 1000, timeoutMs: 60000 }, journal, workerStatus);
  t.after(async () => { await worker.close(); journal.close(); await rm(root, { recursive: true, force: true }); });
  const context = workspaceContext(worker), calls = [], failures = [];
  /** @type {import('../../src/worker/infrastructure/workspace-services.js').WorkspaceProviderFactory} */
  const factory = (connection, _directory, _transport, options) => ({
    configuration: { id: connection.id, model: connection.model, authenticationMode: connection.authenticationMode, instruction: '' }, capabilities: modelCapabilities,
    get toolManifest() { return options.tools().manifest; }, toolManifestFor(scope) { return options.tools(scope).manifest; },
    async reply() { throw Error('Expected typed provider dispatch.'); },
    async execute(dispatch, signal) {
      calls.push(dispatch); const tools = options.tools(dispatch.policy);
      try {
        const observed = await tools.call('werk_candidate_status', {}, signal); assert.notEqual(observed.isError, true);
        const candidate = JSON.parse(observed.content.map(item => item.text).join('\n'));
        const file = candidate.files.find(item => item.path === 'src/value.mjs'); assert.ok(file?.hash);
        const changed = await tools.call('werk_candidate_apply', { path: 'src/value.mjs', content: 'export const value = 2;\n', expectedHash: file.hash }, signal);
        assert.notEqual(changed.isError, true); return { type: 'completed', text: 'Implemented the accepted value change; independently verify the candidate before review.' };
      } catch (error) { failures.push(error); throw error; } finally { await tools.close(); }
    },
  });
  taskboardRuntime(worker.board).model = workspaceModelFactory(state, worker.settings, factory, worker.consumption, worker.sessions.runs, { supervisor: () => context.processes, observations: context.processObservations });
  await worker.init();
  await worker.updateSettings({ provider: { id: 'claude-cli', authenticationMode: 'cli-account', executable: process.execPath, model: 'fixture-claude' }, board: { paused: true } });
  const discovery = worker.repositoryStatus().discovery;
  await worker.repositoryCommand({ action: 'accept', discoveryId: discovery.id, watch: false });
  await worker.updateSettings({ repositories: { pollMs: 60000, items: [{ id: 'project', path: repository, remote: 'origin', branch: 'main', watch: false }] } });
  const grant = worker.settings.toolPolicy();
  await worker.updateToolAccess({ expectedRevision: grant.revision, builtins: { ...grant.builtins, files: true, commands: [{ id: 'candidate-check', name: 'Verify actual candidate value', executable: process.execPath, args: ['tests/value.mjs'], enabled: true, verification: true }] }, mcp: [] });
  const gates = worker.sessions.requests.policy(); gates.policy.reviewer.enabled = false;
  await worker.requestCommand({ action: 'set_policy', expectedRevision: gates.revision, operationId: 'manual-shared-review', policy: gates.policy });
  const policyView = await worker.requestCommand({ action: 'delivery_policy', projectId: 'project' });
  assert.ok('configurationDigest' in policyView && 'approvalRevision' in policyView);
  await worker.requestCommand({ action: 'approve_delivery_policy', repositoryId: 'project', configurationDigest: policyView.configurationDigest, expectedApprovalRevision: policyView.approvalRevision });
  const shared = worker.sharedIntakeView('project');
  await worker.sharedIntakeCommand({ action: 'configure', projectId: 'project', expectedRevision: shared.revision,
    config: { enabled: true, repositoryId: 'project', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 1000 } });
  await writeFile(join(producer, 'features', 'release.md'), request); git(producer, 'add', 'features/release.md'); git(producer, 'commit', '-m', 'Submit shared feature'); git(producer, 'push', 'origin', 'main');
  const baseline = git(producer, 'rev-parse', 'HEAD');
  await worker.updateSettings({ board: { paused: false } });
  const deadline = performance.now() + (process.platform === 'win32' ? 210000 : 60000);
  let result;
  while (performance.now() < deadline) {
    await worker.sharedIntakeCommand({ action: 'sync', projectId: 'project' }); await worker.board.tick();
    if (failures.length) throw failures[0];
    const record = worker.sharedIntakeView('project').requests.find(item => item.id === 'shared-release-feature');
    assert.equal(record?.error ?? null, null, 'Shared admission must not reject the configured host state path.');
    if (record?.taskId) {
      const task = worker.board.executionDetail(record.taskId);
      result = task.requestId ? worker.sessions.requests.get(task.requestId) : undefined;
      if (result?.phase === 'review' && record.status === 'ready_for_review' && record.publication === 'synced' && !worker.sessions.executor.busy) break;
    }
    await delay(20);
  }
  const handedOff = worker.sharedIntakeView('project').requests.find(item => item.id === 'shared-release-feature');
  assert.equal(result?.phase, 'review', JSON.stringify(worker.sharedIntakeView('project')));
  assert.equal(handedOff?.status, 'ready_for_review'); assert.equal(handedOff.publication, 'synced'); assert.ok(handedOff.reviewNote && handedOff.featureBranch);
  const review = parseFeature(git(remote, 'show', 'main:' + handedOff.reviewNote)).data;
  assert.equal(review.policyDigest, result.policyDigest); assert.notEqual(review.workflowPolicyDigest, result.policyDigest);
  assert.equal(git(remote, 'show', handedOff.featureBranch + ':src/value.mjs'), 'export const value = 2;');
  assert.equal(context.config.stateDir, await realpath(state));
  assert.equal(calls.length, 1); assert.equal(calls[0].provider.id, 'claude-cli');
  const acceptedContext = /** @type {{deliveryPolicy:import('../../src/worker/application/delivery-policy.ts').DeliveryPolicySnapshot}} */ (result.input.context);
  assert.equal(acceptedContext.deliveryPolicy.baseline, baseline);
  assert.deepEqual(acceptedContext.deliveryPolicy.configuration.release, policy.release);
  assert.equal(acceptedContext.deliveryPolicy.configuration.execution, undefined);
  assert.ok(result.delivery?.review?.candidate); assert.equal(result.delivery.review.candidate.baseline, baseline);
  assert.ok(result.delivery.review.checks.some(check => check.presetId === 'candidate-check'));
  assert.equal(await readFile(join(repository, 'src', 'value.mjs'), 'utf8'), 'export const value = 1;\n');
});
