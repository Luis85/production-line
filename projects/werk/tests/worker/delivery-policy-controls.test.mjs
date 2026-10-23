import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture, provider } from './request-gate-fixtures.mjs';
import { defaultDeliveryProjectPolicy } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';
import { readDeliveryPolicy } from '../../src/worker/dist/worker/infrastructure/delivery-policy.js';
import { DeliveryPolicyApprovals } from '../../src/worker/dist/worker/infrastructure/delivery-policy-approvals.js';
import { deliveryPolicyCommand, authorizeTaskDelivery, authorizeDeliveryPolicy } from '../../src/worker/dist/worker/status/workspace-delivery-policy.js';

prepareNativeProcessFixture();

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
async function setup(t) {
  const { directory, journal } = await fixture(t), repository = join(directory, 'repo');
  await mkdir(repository); await mkdir(join(repository, '.werk'));
  git(repository, 'init', '-b', 'main'); git(repository, 'config', 'user.name', 'Fixture'); git(repository, 'config', 'user.email', 'fixture@example.invalid');
  const configuration = { ...defaultDeliveryProjectPolicy(), coordination: { maxActiveRequests: 2, dependencyPlanning: 'topological' } };
  await writeFile(join(repository, '.werk/delivery-policy.json'), JSON.stringify(configuration));
  git(repository, 'add', '.werk/delivery-policy.json'); git(repository, 'commit', '-m', 'Project policy');
  const snapshot = await readDeliveryPolicy(repository, new AbortController().signal), policy = defaultGatePolicy(); policy.reviewer.enabled = false;
  let request = journal.ensure({ owner: { sessionId: 'session', rootTurnId: 'turn', taskId: 'task' }, provider, policy,
    input: { kind: 'patch', title: 'Scoped work', message: 'Implement the accepted bounded request.', criteria: ['The result is observable.'], files: [{ path: 'source.txt', bytes: 1 }], context: { repositoryId: 'project', deliveryPolicy: snapshot, implementation: { mode: 'development' } } } });
  journal.evaluate(request.id, 'ready'); journal.bindTurn(request.id, 'turn'); request = journal.prepareExecution(request.id, 'turn', 'invocation');
  const task = /** @type {Parameters<typeof authorizeTaskDelivery>[1]} */ (/** @type {unknown} */ ({ id: 'task', requestId: request.id, repositoryId: 'project', deliveryPolicy: snapshot }));
  const approvals = new DeliveryPolicyApprovals(directory); await approvals.init();
  t.after(() => approvals.close());
  const assignment = { id: 'project', path: repository, remote: 'origin', watch: false };
  const workspace = /** @type {Parameters<typeof deliveryPolicyCommand>[0]} */ (/** @type {unknown} */ ({ config: { projectDir: repository }, repositoryStop: new AbortController(), acceptingTasks: true,
    settings: { value: { repositories: { items: [assignment] }, board: { maxParallel: 2 } } },
    repositories: { resolve(id) { assert.equal(id, 'project'); return assignment; } }, deliveryApprovals: approvals,
    board: { view() { return { tasks: [task] }; } }, sessions: { requests: journal },
  }));
  const command = (action, revision) => deliveryPolicyCommand(workspace, { action, repositoryId: 'project', configurationDigest: snapshot.configurationDigest, expectedApprovalRevision: revision });
  return { workspace, approvals, task, journal, request, snapshot, repository, configuration, command };
}

test('revocation interrupts the current known run and every fresh dispatch rejects its formerly approved policy', async t => {
  const f = await setup(t);
  assert.throws(() => authorizeTaskDelivery(f.workspace, f.task), /approval/);
  await f.command('approve_delivery_policy', 1);
  authorizeTaskDelivery(f.workspace, f.task); authorizeDeliveryPolicy(f.workspace, 'project', f.snapshot.configurationDigest);
  const running = f.journal.deliveryUpdate(f.request.id, { action: 'start', deliveryRunId: f.request.delivery.id, stepId: 'implement', phase: 'implementing', invocationRunId: 'invocation' });
  await f.command('revoke_delivery_policy', 2);
  const revoked = f.journal.get(f.request.id);
  assert.equal(revoked.delivery.control.action, 'interrupt'); assert.equal(revoked.delivery.status, 'interrupting');
  assert.ok(revoked.delivery.holds.some(hold => hold.code === 'policy_approval'));
  assert.throws(() => authorizeTaskDelivery(f.workspace, f.task), /approval/);
  assert.throws(() => authorizeDeliveryPolicy(f.workspace, 'project', f.snapshot.configurationDigest), /not approved/);
  await f.command('approve_delivery_policy', 3);
  const grantedAgain = f.journal.get(f.request.id);
  assert.equal(grantedAgain.delivery.control.action, 'interrupt', 'Approval must not silently resume a stopped or stopping operation.');
  assert.equal(grantedAgain.delivery.holds.some(hold => hold.code === 'policy_approval'), false);
  assert.equal(running.delivery.steps.length, grantedAgain.delivery.steps.length);
});

test('approval binds the inspected committed configuration and changed policy cannot inherit a grant', async t => {
  const f = await setup(t);
  await assert.rejects(deliveryPolicyCommand(f.workspace, { action: 'approve_delivery_policy', repositoryId: 'project', configurationDigest: 'f'.repeat(64), expectedApprovalRevision: 1 }), /changed/);
  assert.equal(f.approvals.view().revision, 1);
  await f.command('approve_delivery_policy', 1);
  f.configuration.coordination.maxActiveRequests = 3;
  await writeFile(join(f.repository, '.werk/delivery-policy.json'), JSON.stringify(f.configuration));
  git(f.repository, 'add', '.werk/delivery-policy.json'); git(f.repository, 'commit', '-m', 'Changed project limits');
  const view = await deliveryPolicyCommand(f.workspace, { action: 'delivery_policy', projectId: 'project' });
  assert.ok('configurationDigest' in view && 'approved' in view);
  assert.equal(view.approved, false); assert.notEqual(view.configurationDigest, f.snapshot.configurationDigest);
  authorizeTaskDelivery(f.workspace, f.task); // Existing runs retain their exact approved snapshot.
  await assert.rejects(f.command('approve_delivery_policy', 2), /changed/);
  await f.command('revoke_delivery_policy', 2); // Old pinned versions remain individually revocable.
  assert.throws(() => authorizeTaskDelivery(f.workspace, f.task), /approval/);
});


test('policy control rejects coerced action values without mutating an existing grant', async t => {
  const f = await setup(t);
  await f.command('approve_delivery_policy', 1);
  const before = f.approvals.view();
  for (const action of [['approve_delivery_policy'], ['revoke_delivery_policy'], { toString: () => 'revoke_delivery_policy' }]) {
    await assert.rejects(f.command(action, before.revision), /supported project delivery policy action/);
    assert.deepEqual(f.approvals.view(), before);
    authorizeTaskDelivery(f.workspace, f.task);
  }
});
