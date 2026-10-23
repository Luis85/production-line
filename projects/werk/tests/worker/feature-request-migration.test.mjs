import { workspaceContext } from './runtime-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { WorkerRequestJournal } from '../../src/worker/dist/worker/infrastructure/journal/requests.js';
import { restoreFeatureRequestReferences } from '../../src/worker/dist/worker/application/feature-request-migration.js';
import { featureRequestReference, sharedFeatureRequestReference, interactionFeatureRequest } from '../../src/worker/dist/worker/application/feature-request-reference.js';
import { SharedFeatureIntake } from '../../src/worker/dist/worker/application/shared-feature-intake.js';
import { defaultSharedIntakeConfig } from '../../src/worker/dist/worker/application/shared-feature-state.js';
import { LocalTaskboard, WorkerSessions } from './application-fixtures.mjs';
import { trackingSharedRecord } from './tracking-fixtures.mjs';
import { workerStatus } from '../helpers/worker-status.mjs';

async function removeParentReferences(directory, includeFolder = false) {
  for (const name of ['sessions.json', 'taskboard.json', ...(includeFolder ? ['feature-index.json'] : [])]) {
    const path = join(directory, name), value = JSON.parse(await readFile(path, 'utf8'));
    for (const record of Array.isArray(value) ? value : value.records) delete record.feature;
    await writeFile(path, JSON.stringify(value));
  }
  const db = new DatabaseSync(join(directory, 'worker-requests.sqlite'));
  try {
    for (const row of db.prepare('SELECT id,payload FROM worker_requests').all()) {
      const request = JSON.parse(String(row.payload)); delete request.owner.featureId;
      db.prepare('UPDATE worker_requests SET payload=? WHERE id=?').run(JSON.stringify(request), row.id);
    }
  } finally { db.close(); }
}

function assertSameAcceptedRequest(before, after) {
  assert.equal(after.id, before.id); assert.equal(after.inputHash, before.inputHash);
  assert.equal(after.inputRevision, before.inputRevision); assert.equal(after.policyDigest, before.policyDigest);
  assert.deepEqual(after.input, before.input); assert.deepEqual(after.provider, before.provider);
  assert.equal(after.execution?.turnId, before.execution?.turnId);
  assert.equal(after.execution?.runId, before.execution?.runId);
}

test('legacy folder restart restores one parent to source, session, task and gate without redispatch', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-folder-upgrade-')));
  const repository = join(directory, 'project'), state = join(directory, 'state'), features = join(repository, 'features');
  await mkdir(features, { recursive: true }); await mkdir(state); await writeFile(join(repository, 'approved.txt'), 'untouched\n');
  const config = { stateDir: state, projectDir: repository, features: { directory: features, provider: 'openai-api', pollMs: 1000 }, pollMs: 1000, timeoutMs: 60000 };
  /** @type {WorkerWorkspace} */ let workspace;
  /** @type {SnapshotJournal} */ let journal;
  async function open() {
    journal = new SnapshotJournal(state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
    workspace = new WorkerWorkspace(config, journal, workerStatus); await workspace.init();
  }
  async function close() { await workspace?.close(); journal?.close(); }
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  await open(); await workspace.updateSettings({ board: { paused: true }, provider: { id: 'openai-api', apiKey: 'fixture-only', model: 'fixture' } });
  await writeFile(join(features, 'export.md'), '---\nschemaVersion: 1\nid: export-feature\ntitle: Export feature\nstatus: ready\nmode: patch\npaths: [approved.txt]\nprovider: openai-api\n---\nImplement the approved export.\n');
  await workspaceContext(workspace).features.tick(true); await workspaceContext(workspace).features.tick(true);
  const task = workspace.board.view().tasks[0], source = workspaceContext(workspace).features.view().records[0];
  assert.ok(task); assert.equal(source.feature.source, 'folder');
  const before = workspace.sessions.requests.forSession(task.sessionId);
  const runCount = workspace.sessions.runs.list({ sessionId: task.sessionId }).total;
  await close(); await removeParentReferences(state, true); await open();
  const restored = workspace.board.view().tasks[0], after = workspace.sessions.requests.forSession(task.sessionId);
  assert.equal(workspace.sessions.detail(task.sessionId).session.feature.key, source.feature.key);
  assert.equal(restored.feature.key, source.feature.key); assert.equal(after.owner.featureId, source.feature.key);
  assert.equal(workspaceContext(workspace).features.view().records[0].feature.key, source.feature.key);
  assertSameAcceptedRequest(before, after);
  assert.equal(restored.submissionHash, task.submissionHash);
  assert.equal(workspace.sessions.runs.list({ sessionId: task.sessionId }).total, runCount);
  assert.equal(await readFile(join(repository, 'approved.txt'), 'utf8'), 'untouched\n');
  assert.notEqual(restored.status, 'running');
  const revision = after.revision;
  await close(); await open(); assert.equal(workspace.sessions.requests.forSession(task.sessionId).revision, revision);
});


/** @param {import('../../src/worker/application/shared-feature-state.js').SharedFeatureState} retained */
async function migratedSharedIntake(retained) {
  const unreachable = () => { throw Error('Identity recovery must not synchronize Git or dispatch work.'); };
  let stored = structuredClone(retained), saves = 0;
  /** @type {import('../../src/worker/application/shared-feature-state.js').SharedIntakePorts} */
  const ports = {
    load: async () => structuredClone(stored),
    async save(state) {
      saves++; const { measurements, ...workflow } = state;
      assert.deepEqual(workflow, retained, 'Local telemetry migration preserves every accepted lifecycle field.');
      assert.ok(measurements); assert.equal(measurements.length, retained.records.length);
      for (const metric of measurements) { assert.equal(metric.submittedAt, null); assert.equal(metric.complete, false); }
      stored = structuredClone(state);
    },
    repository: unreachable, loadWorkflow: unreachable, ready: unreachable, source: unreachable, renderSource: unreachable, submit: unreachable, inspect: unreachable, canAdmit: () => false,
  };
  const intake = new SharedFeatureIntake(ports); await intake.init(); assert.equal(saves, 1);
  const restarted = new SharedFeatureIntake(ports); await restarted.init();
  assert.equal(saves, 1, 'Already migrated retained history needs no initialization write.');
  assert.deepEqual(restarted.measurements(), intake.measurements()); await restarted.close();
  return intake;
}

test('retained shared claims restore the parent before task recovery even after the active binding changes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-shared-upgrade-')), repository = join(directory, 'project');
  await mkdir(repository); await writeFile(join(repository, 'approved.txt'), 'untouched\n');
  const record = trackingSharedRecord({ taskId: 'shared-feature-upgrade', binding: { ...defaultSharedIntakeConfig(), repositoryId: 'original-project' } });
  const reference = sharedFeatureRequestReference(record);
  const intake = await migratedSharedIntake({ schemaVersion: 1, workerId: 'worker', revision: 1, config: { ...defaultSharedIntakeConfig(), repositoryId: 'different-project' }, records: [record] });
  const settings = new WorkerSettings(directory); await settings.init();
  await settings.update({ board: { paused: true }, provider: { id: 'openai-api', model: 'fixture', apiKey: 'fixture-only' } });
  let calls = 0;
  const model = () => ({ async reply() { calls++; throw Error('Migration must not execute.'); } });
  let sessions = WorkerSessions(directory, settings, model), board = LocalTaskboard(directory, settings, sessions, model);
  function bindSource() { sessions.featureSource = session => intake.referenceForTask(session.id.slice(6), session.feature?.key); }
  bindSource(); await sessions.init(); await board.init();
  t.after(async () => { await board.close(); await sessions.close(); await intake.close(); await rm(directory, { recursive: true, force: true }); });
  await board.create({ title: 'Shared export', instruction: 'Implement the approved export.', repository, paths: ['approved.txt'], provider: 'openai-api' }, { id: record.taskId, hash: 'a'.repeat(64), feature: reference });
  const original = board.view().tasks[0], before = sessions.requests.forSession(original.sessionId);
  await board.close(); await sessions.close(); await removeParentReferences(directory);
  sessions = WorkerSessions(directory, settings, model); board = LocalTaskboard(directory, settings, sessions, model);
  bindSource(); await sessions.init(); await board.init();
  const restored = board.view().tasks[0], after = sessions.requests.forSession(original.sessionId);
  assert.equal(sessions.detail(original.sessionId).session.feature.key, reference.key);
  assert.equal(restored.feature.key, reference.key); assert.equal(after.owner.featureId, reference.key);
  assert.equal(restored.feature.repositoryId, 'original-project');
  assertSameAcceptedRequest(before, after); assert.equal(calls, 0);
  assert.equal(restored.submissionHash, original.submissionHash); assert.notEqual(restored.status, 'running');
});

test('migration uses accepted remote provenance and rejects conflicting parents atomically', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-gate-upgrade-')), journal = new WorkerRequestJournal(directory);
  await journal.init(); t.after(async () => { journal.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = { sessionId: 'remote-assignment', rootTurnId: 'first', taskId: 'assignment', remote: { origin: 'https://factory.example', taskId: 'assignment', attempt: 1, lease: 'lease' } };
  const request = journal.ensure({ owner, input: { kind: 'chat', title: 'Export', message: 'Implement export.', context: { source: { featureId: 'upstream-feature' } } }, provider: { id: 'openai-api', model: 'fixture', instruction: '' } });
  /** @type {import('../../src/worker/application/session-catalog.js').SessionRecord} */
  const record = { id: owner.sessionId, taskId: owner.taskId, kind: 'orchestrator', title: 'Export', provider: 'openai-api', createdAt: new Date().toISOString(), archived: false };
  const expected = featureRequestReference({ id: 'upstream-feature', source: 'orchestrator', scope: owner.remote.origin });
  assert.equal(restoreFeatureRequestReferences([record], journal, () => featureRequestReference({ id: 'assignment', source: 'orchestrator', scope: 'legacy-worker-assignment' })), true);
  assert.equal(record.feature.key, expected.key); assert.equal(journal.get(request.id).owner.featureId, expected.key);
  assertSameAcceptedRequest(request, journal.get(request.id));
  const revision = journal.get(request.id).revision;
  assert.equal(restoreFeatureRequestReferences([record], journal), false); assert.equal(journal.get(request.id).revision, revision);
  assert.throws(() => journal.bindFeature(record.id, interactionFeatureRequest('different').key), /another Feature Request/);
  assert.equal(journal.get(request.id).owner.featureId, expected.key);
});


test('an unsubmitted shared reservation cannot replace an existing or legacy interaction parent on restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-unclaimed-upgrade-'));
  const record = trackingSharedRecord({ taskId: 'reserved-task', submitted: false });
  const reference = sharedFeatureRequestReference(record);
  const intake = await migratedSharedIntake({ schemaVersion: 1, workerId: 'worker', revision: 0, config: defaultSharedIntakeConfig(), records: [record] });
  assert.equal(intake.referenceForTask(record.taskId), undefined);
  assert.equal(intake.referenceForTask(record.taskId, reference.key).key, reference.key);
  const settings = new WorkerSettings(directory); await settings.init();
  const model = () => ({ async reply() { throw Error('Restart must not execute.'); } });
  let sessions = WorkerSessions(directory, settings, model);
  t.after(async () => { await sessions.close(); await intake.close(); await rm(directory, { recursive: true, force: true }); });
  await sessions.init();
  const id = 'local-' + record.taskId;
  await sessions.ensureTask(id, 'local', 'Existing interaction', 'openai-api');
  const original = sessions.detail(id).session.feature;
  for (const legacy of [false, true]) {
    await sessions.close();
    if (legacy) {
      const path = join(directory, 'sessions.json'), saved = JSON.parse(await readFile(path, 'utf8'));
      delete saved.records.find(item => item.id === id).feature; await writeFile(path, JSON.stringify(saved));
    }
    sessions = WorkerSessions(directory, settings, model);
    sessions.featureSource = session => intake.referenceForTask(session.id.slice(6), session.feature?.key);
    await sessions.init();
    assert.equal(sessions.detail(id).session.feature.key, original.key);
    assert.notEqual(sessions.detail(id).session.feature.key, reference.key);
  }
});
