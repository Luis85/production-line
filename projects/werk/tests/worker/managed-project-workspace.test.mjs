import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { managedProjectCommand, managedProjectsView } from '../../src/worker/dist/worker/status/workspace-managed-projects.js';
import { defaultDeliveryProjectPolicy, deliveryPolicySnapshot } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { defaultFeatureWorkflow, defaultFeatureCheck } from '../../src/worker/dist/worker/application/feature-workflow.js';
import { authoringTemplateFor } from '../../src/worker/dist/worker/infrastructure/feature-authoring-assets.js';
import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';

prepareNativeProcessFixture();
/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'werk-managed-composed-')), source = join(root, 'source'), state = join(root, 'state');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(source); await mkdir(state); await mkdir(join(source, '.werk')); await mkdir(join(source, 'features', '_templates'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  const policy = defaultDeliveryProjectPolicy();
  await writeFile(join(source, '.werk', 'delivery-policy.json'), JSON.stringify(policy));
  await writeFile(join(source, '.werk', 'feature-workflow.json'), JSON.stringify(defaultFeatureWorkflow()));
  await writeFile(join(source, 'features', '_templates', 'feature-request.md'), authoringTemplateFor('claude-cli'));
  await writeFile(join(source, 'fr-ready-check.json'), JSON.stringify(defaultFeatureCheck('ready')));
  await writeFile(join(source, 'fr-done-check.json'), JSON.stringify(defaultFeatureCheck('done')));
  await writeFile(join(source, 'Feature Requests.base'), 'views: []\n');
  git('add', '.'); git('commit', '-m', 'Project workflow');
  const digest = deliveryPolicySnapshot(policy, git('rev-parse', 'HEAD')).configurationDigest;
  /** @type {{repositoryId:string,configurationDigest:string}[]} */ let approvals = [];
  let updates = 0, configured = 0;
  /** @type {import('../../src/worker/application/provider-contract.ts').ProviderConnection[]} */ let providers = [];
  /** @type {import('../../src/worker/application/repositories.ts').RepositoryConfiguration} */ let repositories = { pollMs: 30000, items: [] };
    let binding = { enabled: false, repositoryId: '', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 1000 }, revision = 0;
  const runtime = { get repository() { return repositories.items[0]?.path ?? source; }, sharedRuntime: {
    intake: { get binding() { return binding; }, view() { return { config: binding, revision }; }, async configure(value, expected) { assert.equal(expected, revision); binding = value; revision++; } },
    async selectedBaseline() {
      const checkout = repositories.items[0]?.path ?? source;
      execFileSync('git', ['fetch', '--no-write-fetch-head', 'origin', 'main'], { cwd: checkout, stdio: ['ignore', 'pipe', 'pipe'] });
      return git('rev-parse', 'HEAD');
    },
  } };
  const workspace = /** @type {import('../../src/worker/status/workspace-context.ts').WorkspaceContext} */ (/** @type {unknown} */ ({
    config: { stateDir: state }, repositoryStop: new AbortController(), acceptingTasks: true, configurationUpdating: false, repositoriesUpdating: false,
    repositoryPreparations: 0, sessions: { busy: false }, board: { active: 0 }, get: () => ({ activeTasks: [], queuedTasks: [] }),
    settings: { get value() { return { repositories, providers }; }, async update(input) { repositories = structuredClone(input.repositories); updates++; } },
    deliveryApprovals: { view: () => ({ approvals }) }, repositoryDiscovery: { async assignmentsChanged() {} },
    repositories: { async configure() { configured++; } }, featureProjects: { busy: false, assertAssignments() {}, async configure() {}, resolve: () => runtime, repository: project => project.repository, id: () => 'sample' },
  }));
  return { workspace, repository: pathToFileURL(source).toString(), digest, get updates() { return updates; }, get configured() { return configured; },
    approve(configurationDigest = digest) { approvals = [{ repositoryId: 'sample', configurationDigest }]; }, revoke() { approvals = []; },
    claudeExecutable(path) { providers = [{ id: 'claude-cli', executable: path, model: '', apiKey: '', authenticationMode: 'cli-account' }]; },
    async changePolicy(change = {}) { Object.assign(policy, change); policy.version++; await writeFile(join(source, '.werk', 'delivery-policy.json'), JSON.stringify(policy)); git('add', '.werk/delivery-policy.json'); git('commit', '-m', 'Updated project policy'); return deliveryPolicySnapshot(policy, git('rev-parse', 'HEAD')).configurationDigest; },
    items: () => repositories.items };
}

test('managed composition registers a repository but requires committed policy approval before enabling intake', async t => {
  const h = await fixture(t);
  const initial = await managedProjectCommand(h.workspace, { action: 'register', operationId: 'register-composed', id: 'sample', name: 'Sample project', repository: h.repository, intake: 'local' });
  assert.equal(initial.projects.length, 1); assert.equal(initial.projects[0].name, 'Sample project');
  assert.equal(initial.projects[0].status, 'ready'); assert.equal(initial.projects[0].intakeEnabled, false);
  assert.equal(h.items()[0].watch, false); assert.equal(h.items()[0].features, undefined);
  assert.deepEqual(initial.projects[0].workflow, { configured: true, templates: [{ id: 'feature-request-v1', path: 'features/_templates/feature-request.md', label: 'Project Feature Request' }] });
  h.approve();
  const enabled = await managedProjectCommand(h.workspace, { action: 'reconcile', operationId: 'enable-approved', id: 'sample' });
  assert.equal(enabled.projects[0].intakeEnabled, true); assert.equal(h.items()[0].features.directory, 'features');
  assert.equal(h.updates, 2);
  await managedProjectCommand(h.workspace, { action: 'reconcile', operationId: 'enable-approved', id: 'sample' });
  assert.equal(h.updates, 2); assert.equal(h.configured, 3);
  assert.equal((await managedProjectsView(h.workspace)).diagnostics.length, 3);
  assert.equal(h.workspace.repositoriesUpdating, false);
});

test('repository admission guards reject overlap and preserve existing assignments', async t => {
  const h = await fixture(t);
  h.workspace.repositoriesUpdating = true;
  await assert.rejects(managedProjectCommand(h.workspace, { action: 'register', operationId: 'overlap', id: 'sample', repository: h.repository }), /changing repository assignments/);
  h.workspace.repositoriesUpdating = false;
  await h.workspace.settings.update({ repositories: { pollMs: 30000, items: [{ id: 'sample', path: '/another-checkout', remote: 'origin', watch: false }] } });
  const result = await managedProjectCommand(h.workspace, { action: 'register', operationId: 'existing-id', id: 'sample', repository: h.repository });
  assert.equal(result.projects[0].status, 'needs_attention'); assert.equal(result.projects[0].attached, false);
  assert.match(result.projects[0].detail, /already belongs to another checkout/);
  assert.equal(result.projects[0].intakeBlockedReason, result.projects[0].detail);
  assert.equal(h.items()[0].path, '/another-checkout'); assert.equal(h.workspace.repositoriesUpdating, false);
});

test('new managed projects default to shared Git intake and enable the canonical binding after approval', async t => {
  const h = await fixture(t);
  const registered = await managedProjectCommand(h.workspace, { action: 'register', operationId: 'shared-register', id: 'sample', repository: h.repository });
  assert.equal(registered.projects[0].intake, 'shared'); assert.equal(registered.projects[0].intakeEnabled, false);
  assert.equal(h.items()[0].features, undefined);
  h.approve();
  const enabled = await managedProjectCommand(h.workspace, { action: 'reconcile', operationId: 'shared-enable', id: 'sample' });
  assert.equal(enabled.projects[0].status, 'ready'); assert.equal(enabled.projects[0].intakeEnabled, true);
  assert.equal(h.items()[0].features, undefined);
  const binding = h.workspace.featureProjects.resolve('sample').sharedRuntime.intake.binding;
  assert.equal(binding.enabled, true); assert.equal(binding.repositoryId, 'sample'); assert.equal(binding.branch, 'main');
});

test('managed setup distinguishes pending activation, revoked approval and restored shared policy', async t => {
  const h = await fixture(t);
  await managedProjectCommand(h.workspace, { action: 'register', operationId: 'observe-register', id: 'sample', repository: h.repository });
  h.approve();
  const pending = (await managedProjectsView(h.workspace)).projects[0];
  assert.equal(pending.policyApproved, true); assert.equal(pending.intakeEnabled, false); assert.match(pending.intakeBlockedReason, /Recheck project setup/);
  await managedProjectCommand(h.workspace, { action: 'reconcile', operationId: 'observe-enable', id: 'sample' });
  assert.equal((await managedProjectsView(h.workspace)).projects[0].intakeBlockedReason, null);
  h.revoke();
  const revoked = (await managedProjectsView(h.workspace)).projects[0];
  assert.equal(revoked.intakeEnabled, true); assert.equal(revoked.policyApproved, false); assert.match(revoked.intakeBlockedReason, /not approved/);
  h.approve();
  assert.equal((await managedProjectsView(h.workspace)).projects[0].policyApproved, true);
  const changedDigest = await h.changePolicy();
  const changed = (await managedProjectsView(h.workspace)).projects[0];
  assert.equal(changed.policyApproved, false); assert.match(changed.intakeBlockedReason, /not approved/);
  h.approve(changedDigest);
  const restored = (await managedProjectsView(h.workspace)).projects[0];
  assert.equal(restored.policyApproved, true); assert.equal(restored.intakeBlockedReason, null);
});

test('prerequisite diagnostics refuse a configured directory as a Claude executable', async t => {
  const h = await fixture(t); h.claudeExecutable(h.workspace.config.stateDir);
  const view = await managedProjectsView(h.workspace);
  assert.equal(view.diagnostics.find(item => item.id === 'claude').available, false);
});


test('GitHub diagnostics require explicit current policy approval and remain optional for plain Git', async t => {
  const h = await fixture(t);
  const github = async () => (await managedProjectsView(h.workspace)).diagnostics.find(item => item.id === 'github');
  assert.equal((await github()).required, false, 'A worker without an opted-in project does not require GitHub.');
  await managedProjectCommand(h.workspace, { action: 'register', operationId: 'plain-git-diagnostics', id: 'sample', repository: h.repository });
  h.approve();
  await managedProjectCommand(h.workspace, { action: 'reconcile', operationId: 'plain-git-enable', id: 'sample' });
  let row = await github(); assert.equal(row.required, false); assert.equal(row.applicable, false); assert.match(row.detail, /Plain Git.*PullRequest Markdown/);
  const push = { remote: 'origin', repository: 'example/project', base: 'main', push: true, pullRequest: false, draft: true };
  h.approve(await h.changePolicy({ remoteDelivery: push }));
  assert.equal((await github()).required, false, 'Git push alone does not require a GitHub CLI.');
  const digest = await h.changePolicy({ remoteDelivery: { ...push, pullRequest: true } });
  assert.equal((await github()).required, false, 'Unapproved GitHub configuration does not activate the integration.');
  h.approve(digest); row = await github(); assert.equal(row.required, true); assert.equal(row.applicable, true);
  assert.match(row.detail, /approved project policy.*GitHub/);
  h.revoke(); assert.equal((await github()).required, false, 'Revocation removes the optional integration prerequisite.');
});
