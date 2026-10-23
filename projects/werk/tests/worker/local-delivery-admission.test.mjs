import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask } from '../../src/worker/dist/worker/application/local-task-create.js';
import { defaultToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { defaultDeliveryProjectPolicy, deliveryPolicySnapshot } from '../../src/worker/dist/worker/application/delivery-policy.js';

const baseline = 'a'.repeat(40);
/** Application boundary fixture: no Git or provider operation is simulated as completed work. */
function fixture() {
  const policy = defaultToolPolicy();
  policy.builtins.files = true;
  policy.builtins.commands = [{ id: 'verify', name: 'Required source check', executable: process.execPath, args: ['--version'], enabled: true, verification: true }];
  /** @type {import('../../src/worker/application/local-task-contracts.js').LocalTask[]} */
  const tasks = [];
  /** @type {Awaited<ReturnType<import('../../src/worker/application/local-task-contracts.js').LocalTaskWorkspaces['prepareWorktree']>>} */
  const prepared = { repository: '/fixture/repository', path: '/fixture/worktree', baseCommit: baseline };
  /** @type {import('../../src/worker/application/local-task-contracts.js').LocalTaskSubmission} */
  const submission = { id: 'canonical-admission', hash: 'b'.repeat(64), baseCommit: baseline,
    deliveryPolicy: deliveryPolicySnapshot(defaultDeliveryProjectPolicy(), baseline) };
  const calls = { snapshots: 0, identities: 0, models: 0, dispatches: 0, blocks: 0, requests: 0 };
  const provider = { id: 'openai-api', model: 'fixture', authenticationMode: 'api-key' };
  const host = /** @type {Parameters<typeof createTask>[0]} */ (/** @type {unknown} */ ({
    tasks, closed: false, admissionReserved: false, workspaceController: new AbortController(), persistenceError: false,
    settings: { toolPolicy: () => policy, provider: () => provider },
    admissionInput: () => ({ body: {}, title: 'Change the approved source', instruction: 'Implement and verify the accepted source change.',
      provider, selection: { provider: provider.id, model: provider.model, effort: 'default', authenticationMode: provider.authenticationMode },
      selector: prepared.repository, repositoryPath: prepared.repository, allowedPaths: ['source.ts'] }),
    assertAdmissionCapacity() {}, view: () => ({ tasks: structuredClone(tasks) }),
    workspaces: { async prepareWorktree() { return prepared; } },
    development() { throw Error('Admission cannot start development.'); },
    delivery() { throw Error('Admission cannot publish a candidate.'); },
    files: {
      async snapshot(worktree, paths) { calls.snapshots++; assert.deepEqual(paths, ['source.ts']); return { ...worktree, files: [{ path: 'source.ts', content: 'original', existed: true }] }; },
      async identity() { calls.identities++; return { dev: 1, ino: 2, birthtimeMs: 3 }; },
    },
    model() { calls.models++; return undefined; },
    async change(operation) { await operation(tasks); },
    input: task => task.instruction, context: () => ({}),
    ensureRequest(task) { calls.requests++; task.requestId = 'request-' + task.id; return { id: task.requestId, inputRevision: 1 }; },
    async prepareTurn() { calls.dispatches++; },
    sessions: {
      async ensureTask() {}, async blockContinuation() { calls.blocks++; }, protectTask() {}, async prepareTask() {}, notifyRequest() {},
      requests: { evaluate: () => ({ passed: true }), bindTurn() {} },
      interactions: { accept: () => ({ duplicate: false, turn: { id: 'accepted-turn' } }) },
    },
  }));
  const assertNoAdmission = () => {
    assert.equal(tasks.length, 0, 'A blocked canonical request cannot become a queued proposal.');
    assert.deepEqual(calls, { snapshots: 0, identities: 0, models: 0, dispatches: 0, blocks: 0, requests: 0 });
  };
  return { host, tasks, calls, policy, prepared, submission, assertNoAdmission, create: () => createTask(host, {}, submission) };
}

for (const missing of ['files', 'required-check', 'enabled-check']) {
  test(`canonical exact-file delivery refuses missing ${missing} before snapshots or provider preparation`, async () => {
    const f = fixture();
    if (missing === 'files') f.policy.builtins.files = false;
    if (missing === 'required-check') f.policy.builtins.commands[0].verification = false;
    if (missing === 'enabled-check') f.policy.builtins.commands[0].enabled = false;
    await assert.rejects(f.create(), /repository file access.*enabled required verification check.*Settings.*retry this Feature Request/);
    f.assertNoAdmission();
  });
}

for (const service of ['development', 'delivery']) {
  test(`canonical exact-file delivery refuses a missing ${service} service`, async () => {
    const f = fixture(); f.host[service] = undefined;
    await assert.rejects(f.create(), /requires the repository worktree, development and delivery services/);
    f.assertNoAdmission();
  });
}

test('canonical exact-file delivery cannot use an ordinary folder without a worktree service', async () => {
  const f = fixture(); f.host.workspaces = undefined;
  await assert.rejects(f.create(), /prepared task worktree does not match its reserved source commit|requires the repository worktree/);
  f.assertNoAdmission();
});

for (const source of ['missing-reservation', 'different-policy', 'missing-prepared-commit', 'different-prepared-commit']) {
  test(`canonical exact-file delivery requires the actual committed baseline: ${source}`, async () => {
    const f = fixture();
    if (source === 'missing-reservation') delete f.submission.baseCommit;
    if (source === 'different-policy') f.submission.deliveryPolicy = deliveryPolicySnapshot(defaultDeliveryProjectPolicy(), 'c'.repeat(40));
    if (source === 'missing-prepared-commit') delete f.prepared.baseCommit;
    if (source === 'different-prepared-commit') f.prepared.baseCommit = 'd'.repeat(40);
    await assert.rejects(f.create(), /committed request and policy baseline|prepared task worktree does not match its reserved source commit/);
    f.assertNoAdmission();
  });
}

test('configuring the required check admits the same exact-file reservation as implementation', async () => {
  const f = fixture(), acceptedReservation = structuredClone(f.submission);
  f.policy.builtins.commands[0].verification = false;
  await assert.rejects(f.create(), /Configure tool access in Settings/); f.assertNoAdmission();
  f.policy.builtins.commands[0].verification = true;
  f.prepared.reused = true; f.prepared.pristine = true;
  await f.create();
  assert.equal(f.tasks.length, 1); assert.equal(f.tasks[0].id, acceptedReservation.id);
  assert.deepEqual(f.submission, acceptedReservation);
  assert.equal(f.tasks[0].status, 'queued'); assert.equal(f.tasks[0].implementation?.mode, 'worktree');
  assert.equal(f.tasks[0].implementation?.baseCommit, baseline);
  assert.deepEqual(f.tasks[0].implementation?.approvedPaths, ['source.ts']);
  assert.equal(f.tasks[0].implementation?.checks.length, 1);
  assert.equal(f.calls.snapshots, 1); assert.equal(f.calls.dispatches, 1);
  await f.create();
  assert.equal(f.tasks.length, 1); assert.equal(f.calls.dispatches, 1, 'Reservation replay must not prepare another invocation.');
});

test('interrupted canonical admission retains a failed receipt even after grants and services are removed', async () => {
  const f = fixture(); f.prepared.reused = true; f.prepared.pristine = false;
  f.policy.builtins.files = false; f.policy.builtins.commands = [];
  f.host.development = undefined; f.host.delivery = undefined;
  await f.create();
  const task = f.tasks[0];
  assert.equal(task.status, 'failed'); assert.deepEqual(task.admissionFailure, { paths: ['source.ts'] });
  assert.equal(task.worktree, f.prepared.path); assert.deepEqual(task.files, []);
  assert.equal(task.implementation, undefined); assert.match(task.error ?? '', /retained worktree has changed/);
  assert.deepEqual(f.calls, { snapshots: 0, identities: 0, models: 0, dispatches: 0, requests: 0, blocks: 1 });
});

test('legacy exact-file proposals keep their existing admission behavior without implementation grants', async () => {
  const f = fixture(); delete f.submission.deliveryPolicy;
  f.policy.builtins.files = false; f.policy.builtins.commands = [];
  f.host.development = undefined; f.host.delivery = undefined;
  await f.create();
  assert.equal(f.tasks.length, 1); assert.equal(f.tasks[0].status, 'queued');
  assert.equal(f.tasks[0].implementation, undefined); assert.equal(f.tasks[0].deliveryPolicy, undefined);
  assert.equal(f.calls.snapshots, 1); assert.equal(f.calls.dispatches, 1);
});
