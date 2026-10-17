import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { featureRequestReference, interactionFeatureRequest, sessionFeatureRequest, sharedFeatureRequestReference, validateFeatureRequestReference } from '../../src/worker/dist/worker/application/feature-request-reference.js';
import { projectFeatureTracking, renderFeatureTracking } from '../../src/worker/dist/worker/application/feature-tracking.js';
import { createTaskNoteIdentity, renderTaskNote, taskNoteResponse } from '../../src/worker/dist/worker/application/task-notes.js';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { WorkerSessions } from './application-fixtures.mjs';
import { trackingSession, interactionView } from './tracking-fixtures.mjs';

const metadata = markdown => parse(/^---\n([\s\S]*?)\n---/.exec(markdown)[1]);
const binding = { repositoryId: 'project', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json' };

test('request identity separates source namespaces and repositories while surviving note renames', () => {
  const record = { id: 'csv-export', sourcePath: 'features/export.md', binding };
  const shared = sharedFeatureRequestReference(record);
  assert.equal(shared.key, sharedFeatureRequestReference({ ...record, sourcePath: 'features/renamed.md' }).key);
  assert.notEqual(shared.key, sharedFeatureRequestReference({ ...record, binding: { ...binding, repositoryId: 'other-project' } }).key);
  assert.notEqual(shared.key, sharedFeatureRequestReference({ ...record, binding: { ...binding, branch: 'other-intake' } }).key);
  assert.notEqual(shared.key, interactionFeatureRequest(record.id).key);
  assert.notEqual(shared.key, featureRequestReference({ id: record.id, source: 'folder', scope: '/project/features' }).key);
  assert.throws(() => validateFeatureRequestReference({ ...shared, scope: 'other-repository' }), /identity does not match/);
  assert.deepEqual(sessionFeatureRequest({ id: 'local-legacy', kind: 'local' }), interactionFeatureRequest('legacy'));
});

test('external Markdown progress links one parent instead of creating another Feature Request entity', () => {
  const feature = sharedFeatureRequestReference({ id: 'csv-export', sourcePath: 'features/export.md', binding });
  const input = { session: trackingSession('local-run', { kind: 'local', feature }), sourcePath: '/project/features/export.md' };
  const projected = projectFeatureTracking(input);
  const note = renderFeatureTracking(projected, { owner: 'worker', digest: 'digest', updatedAt: '2026-10-17T00:00:00.000Z' });
  const data = metadata(note);
  assert.equal(data.type, 'FeatureRequestProgress'); assert.equal(data.featureRequestKey, feature.key); assert.equal(data.featureRequestId, 'csv-export');
  assert.match(note, /Original request: \/project\/features\/export.md/);
  const direct = metadata(renderFeatureTracking(projectFeatureTracking({ session: trackingSession('direct') }), { owner: 'worker', digest: 'digest', updatedAt: '2026-10-17T00:00:00.000Z' }));
  assert.equal(direct.type, 'feature-request'); assert.equal(direct.featureRequestKey, interactionFeatureRequest('direct').key);
});

test('Task answers bind the parent identity and upgrading preserves already published checkpoints', () => {
  const feature = interactionFeatureRequest('feature-one');
  /** @type {import('../../src/worker/application/interactions.js').InteractionView} */
  const view = { ...interactionView('session'), revision: 4, phase: 'waiting_input',
    pending: { id: 'question', turnId: 'turn', kind: 'question', message: 'UTC or local dates?', createdAt: '2026-10-17T00:00:00.000Z' },
    latestTurn: { id: 'turn', runId: 'run', priorTurnId: null, kind: 'message', status: 'waiting_input', createdAt: '2026-10-17T00:00:00.000Z', finishedAt: '2026-10-17T00:00:00.000Z' },
  };
  const legacy = createTaskNoteIdentity(feature.id, 'worker', view);
  assert.deepEqual(createTaskNoteIdentity(feature.id, 'worker', view, feature.key, legacy), legacy);
  const identity = createTaskNoteIdentity(feature.id, 'worker', view, feature.key);
  const note = renderTaskNote({ identity, title: 'Dates', question: 'UTC or local dates?', status: 'ready', answer: 'Use UTC.' });
  assert.equal(metadata(note).featureRequestKey, feature.key);
  assert.equal(taskNoteResponse(note, identity).command.answer, 'Use UTC.');
  assert.throws(() => taskNoteResponse(note.replace(feature.key, interactionFeatureRequest('another-feature').key), identity), /identity changed/);
  const next = createTaskNoteIdentity(feature.id, 'worker', { ...view, revision: 5 }, feature.key, legacy);
  assert.equal(next.featureRequestKey, feature.key); assert.notEqual(next.id, legacy.id);
});

test('chat follow-ups and restart retain one Feature Request across separate immutable execution requests', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-parent-identity-'));
  const settings = new WorkerSettings(directory); await settings.init();
  const model = () => ({ async reply() { return 'Recorded result.'; } });
  let sessions = WorkerSessions(directory, settings, model);
  t.after(async () => { await sessions.close(); await rm(directory, { recursive: true, force: true }); });
  await sessions.init();
  async function settle() { for (let i = 0; i < 200 && sessions.chat.snapshot().busy; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(sessions.chat.snapshot().busy, false); }
  await sessions.start('Explain the export.'); await settle();
  const first = sessions.requests.forSession('default'); assert.equal(first.phase, 'done');
  await sessions.start('Describe its date format.'); await settle();
  const second = sessions.requests.forSession('default'); assert.notEqual(second.id, first.id);
  assert.equal(first.owner.featureId, second.owner.featureId);
  assert.equal(second.owner.featureId, sessions.view().records[0].feature.key);
  await sessions.close(); sessions = WorkerSessions(directory, settings, model); await sessions.init();
  assert.equal(sessions.view().records[0].feature.key, first.owner.featureId);
  assert.equal(sessions.requests.forSession('default').id, second.id);
});
