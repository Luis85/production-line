import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { managedProjectStorage } from '../../src/worker/dist/worker/infrastructure/managed-project-storage.js';
import { assertDirectFeatureCreation, authorFeature } from '../../src/worker/dist/worker/status/workspace-feature-authoring.js';
import { prepareFeatureExecution } from '../../src/worker/dist/worker/status/workspace-feature-execution.js';
import { prepareTaskWorkspace, repositoryCommand } from '../../src/worker/dist/worker/status/workspace-repositories.js';
import { authorizeIsolatedDeliveryPolicy, deliveryPolicyCommand } from '../../src/worker/dist/worker/status/workspace-delivery-policy.js';

/** @param {import('node:test').TestContext} t @param {boolean} retainedAdoption */
async function fixture(t, retainedAdoption) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk-home-isolation-'))), home = join(root, 'home'), state = join(home, 'state', 'worker'), outside = join(root, 'developer');
  await mkdir(state, { recursive: true }); await mkdir(outside); await writeFile(join(outside, 'user.txt'), 'Unrelated working copy stays untouched.\n');
  const git = (...args) => execFileSync('git', args, { cwd: outside, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('add', '.'); git('commit', '-m', 'Developer work');
  const originalHead = git('rev-parse', 'HEAD'), originalFile = await readFile(join(outside, 'user.txt'), 'utf8');
  const assignment = { id: 'external', path: outside, remote: 'origin', branch: 'main', watch: true };
  if (retainedAdoption) await managedProjectStorage(state).save({ schemaVersion: 1, projects: [{ path: outside, branch: 'main', id: 'external', name: 'Legacy developer checkout', mode: 'adopt', repository: pathToFileURL(outside).href, featuresDirectory: 'features', intake: 'shared', operationId: 'legacy-register', status: 'ready', attached: true, createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z', detail: 'Retained registration', operations: [{ operationId: 'legacy-register', digest: 'a'.repeat(64), action: 'adopt' }] }] });
  let authorCalls = 0, discoveryCalls = 0;
  const project = { sharedRuntime: { intake: { binding: undefined }, authoring: { async command() { authorCalls++; throw Error('Authoring must not run.'); } } } };
  const workspace = /** @type {import('../../src/worker/status/workspace-context.js').WorkspaceContext} */ (/** @type {unknown} */ ({
    config: { stateDir: state, homeDir: home }, repositoryStop: new AbortController(), acceptingTasks: true, repositoriesUpdating: false, configurationUpdating: false, repositoryPreparations: 0,
    repositories: { resolve() { return assignment; } },
    settings: { value: { repositories: { pollMs: 30000, items: [assignment] }, execution: {} } },
    featureProjects: { resolve() { return project; }, id() { return assignment.id; }, repository() { return assignment.path; } },
    repositoryDiscovery: { async assertAllowed() { discoveryCalls++; } },
    deliveryApprovals: { view() { return { revision: 1, approvals: [{ repositoryId: assignment.id, configurationDigest: 'b'.repeat(64), approvedAt: '2026-10-26T00:00:00Z' }] }; } },
  }));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { workspace, outside, async unchanged() { assert.equal(authorCalls, 0); assert.equal(discoveryCalls, 0); assert.equal(workspace.repositoryPreparations, 0); assert.equal(git('rev-parse', 'HEAD'), originalHead); assert.equal(git('status', '--porcelain'), ''); assert.equal(await readFile(join(outside, 'user.txt'), 'utf8'), originalFile); } };
}

for (const retained of [false, true]) test(`Home authoring, admission and delivery refuse ${retained ? 'a retained external adoption' : 'a repository-settings-only assignment'} before touching the developer checkout`, async t => {
  const f = await fixture(t, retained), refused = /isolated managed remote clones/;
  const input = /** @type {import('../../src/worker/application/feature-requests.js').FeatureInput} */ (/** @type {unknown} */ ({ mode: 'patch' }));
  await assert.rejects(assertDirectFeatureCreation(f.workspace, { projectId: 'external' }), refused);
  await assert.rejects(authorFeature(f.workspace, { action: 'prepare', projectId: 'external' }), refused);
  await assert.rejects(prepareFeatureExecution(f.workspace, input, f.outside, 'external'), refused);
  await assert.rejects(prepareTaskWorkspace(f.workspace, 'external', 'task-one', AbortSignal.timeout(5000)), refused);
  await assert.rejects(authorizeIsolatedDeliveryPolicy(f.workspace, 'external', 'b'.repeat(64)), refused);
  await assert.rejects(deliveryPolicyCommand(f.workspace, { action: 'save_delivery_policy_draft', projectId: 'external', expectedFileDigest: null, configuration: {} }), refused);
  await assert.rejects(repositoryCommand(f.workspace, { action: 'accept', discoveryId: 'working-copy' }), /isolated clone/);
  await f.unchanged();
});
