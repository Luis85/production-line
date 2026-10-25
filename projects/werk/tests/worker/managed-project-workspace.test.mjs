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
  /** @type {import('../../src/worker/application/repositories.ts').RepositoryConfiguration} */ let repositories = { pollMs: 30000, items: [] };
    let binding = { enabled: false, repositoryId: '', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 1000 }, revision = 0;
  const runtime = { get repository() { return repositories.items[0]?.path ?? source; }, sharedRuntime: {
    intake: { get binding() { return binding; }, view() { return { config: binding, revision }; }, async configure(value, expected) { assert.equal(expected, revision); binding = value; revision++; } },
    async selectedBaseline() { return git('rev-parse', 'HEAD'); },
  } };
  const workspace = /** @type {import('../../src/worker/status/workspace-context.ts').WorkspaceContext} */ (/** @type {unknown} */ ({
    config: { stateDir: state }, repositoryStop: new AbortController(), acceptingTasks: true, configurationUpdating: false, repositoriesUpdating: false,
    repositoryPreparations: 0, sessions: { busy: false }, board: { active: 0 }, get: () => ({ activeTasks: [], queuedTasks: [] }),
    settings: { get value() { return { repositories, providers: [] }; }, async update(input) { repositories = structuredClone(input.repositories); updates++; } },
    deliveryApprovals: { view: () => ({ approvals }) }, repositoryDiscovery: { async assignmentsChanged() {} },
    repositories: { async configure() { configured++; } }, featureProjects: { busy: false, assertAssignments() {}, async configure() {}, resolve: () => runtime, repository: project => project.repository, id: () => 'sample' },
  }));
  return { workspace, repository: pathToFileURL(source).toString(), digest, get updates() { return updates; }, get configured() { return configured; },
    approve() { approvals = [{ repositoryId: 'sample', configurationDigest: digest }]; }, items: () => repositories.items };
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
