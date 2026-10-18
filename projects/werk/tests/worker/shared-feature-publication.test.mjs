import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sharedHash } from '../../src/worker/dist/worker/application/shared-feature-notes.js';
import { fixture, sourcePath } from './shared-feature-fixture.mjs';

async function pausedReview(t) {
  const f = await fixture(t); await f.intake.sync(); await f.complete();
  const gate = f.blockNextReviewSave(), syncing = f.intake.sync();
  // The real coordinator has persisted the candidate and review identity, but has
  // not yet constructed or sent the lifecycle outbox containing the review note.
  await gate.entered;
  const saved = await f.state(), row = f.intake.view().requests[0];
  const remote = f.repositories.get('shared'), before = structuredClone(remote);
  return { f, gate, syncing, saved, row, remote, before };
}

test('a saved review identity stays publication pending until the source and note are acknowledged', { timeout: 10000 }, async t => {
  const p = await pausedReview(t);
  try {
    assert.equal(p.row.status, 'ready_for_review'); assert.ok(p.row.reviewNote);
    assert.equal(p.remote.files.has(p.row.reviewNote), false, 'The note is not yet on the shared branch.');
    assert.equal(p.row.publication, 'pending', 'A public ready-for-review row must not claim this absent note is synchronized.');
    assert.equal(p.saved.records[0].publication, 'pending', 'The crash snapshot must retain unpublished work.');
  } finally { p.gate.release(); await p.syncing; }
  const row = p.f.intake.view().requests[0], state = (await p.f.state()).records[0];
  assert.equal(row.publication, 'synced'); assert.ok(p.remote.files.has(row.reviewNote));
  assert.equal(state.publishedReview, row.reviewNote + ':' + sharedHash(p.remote.files.get(row.reviewNote)));
  assert.equal(state.publishedState, sharedHash(p.remote.files.get(sourcePath)));
});

for (const recovery of ['persisted pending', 'legacy synced without review receipt', 'legacy synced with stale review receipt', 'legacy synced with stale source receipt']) {
  test(`recovery publishes ${recovery} without repeating execution or the feature branch`, { timeout: 10000 }, async t => {
    const p = await pausedReview(t);
    p.gate.release(); await p.syncing;
    // Reconstruct exactly the durable save and remote state at the stopped
    // boundary. No real repository or running production state is rolled back.
    Object.assign(p.remote, p.before);
    const record = p.saved.records[0];
    if (recovery !== 'persisted pending') record.publication = 'synced';
    if (recovery === 'legacy synced with stale review receipt') record.publishedReview = record.reviewNote + ':' + '0'.repeat(64);
    if (recovery === 'legacy synced with stale source receipt') {
      record.publishedReview = record.reviewNote + ':' + sharedHash(record.reviewMarkdown);
      p.f.commitFiles('shared', { [record.reviewNote]: record.reviewMarkdown });
    }
    await writeFile(join(p.f.directory, 'shared-intake.json'), JSON.stringify(p.saved));
    await p.f.restart();
    assert.equal(p.f.intake.view().requests[0].publication, 'pending', 'Recovery cannot trust a stale synced flag without exact source and artifact receipts.');
    await p.f.intake.sync();
    const row = p.f.intake.view().requests[0], settled = (await p.f.state()).records[0];
    assert.equal(row.status, 'ready_for_review'); assert.equal(row.publication, 'synced');
    assert.ok(p.remote.files.has(row.reviewNote), 'The missing review must be published during recovery.');
    assert.match(p.remote.files.get(sourcePath), /status: ready_for_review/);
    assert.equal(settled.publishedReview, row.reviewNote + ':' + sharedHash(p.remote.files.get(row.reviewNote)));
    assert.equal(settled.publishedState, sharedHash(p.remote.files.get(sourcePath)));
    assert.equal(p.f.primaryExecutions, 1); assert.equal(p.f.submits.length, 1); assert.equal(p.f.featureCommits, 1);
    const writes = p.f.lifecycleAttempts.length;
    await p.f.intake.sync();
    assert.equal(p.f.lifecycleAttempts.length, writes, 'Confirmed source and artifact receipts settle without repeated publication.');
    assert.equal(p.f.primaryExecutions, 1); assert.equal(p.f.featureCommits, 1);
  });
}

test('acknowledging an older outbox cannot synchronize a newer unpublished review', { timeout: 10000 }, async t => {
  const p = await pausedReview(t);
  p.gate.release(); await p.syncing;
  Object.assign(p.remote, p.before);
  const record = p.saved.records[0], content = p.remote.files.get(sourcePath);
  record.pending = { operationId: 'older-confirmed-source', request: { path: sourcePath, expectedRevision: record.remoteRevision, content }, artifacts: [] };
  await writeFile(join(p.f.directory, 'shared-intake.json'), JSON.stringify(p.saved));
  await p.f.restart();
  const gate = p.f.blockNextReviewSave(), syncing = p.f.intake.sync();
  await gate.entered;
  try {
    const saved = (await p.f.state()).records[0];
    assert.equal(saved.pending, undefined, 'The earlier outbox has received its acknowledgement.');
    assert.equal(saved.publishedState, sharedHash(content));
    assert.equal(p.remote.files.has(record.reviewNote), false);
    assert.equal(p.f.intake.view().requests[0].publication, 'pending', 'An old source acknowledgement cannot confirm the later review.');
    assert.equal(saved.publication, 'pending');
  } finally { gate.release(); await syncing; }
  const saved = (await p.f.state()).records[0];
  assert.equal(p.f.intake.view().requests[0].publication, 'synced');
  assert.equal(saved.publishedReview, record.reviewNote + ':' + sharedHash(p.remote.files.get(record.reviewNote)));
  assert.equal(saved.publishedState, sharedHash(p.remote.files.get(sourcePath)));
  assert.equal(p.f.primaryExecutions, 1); assert.equal(p.f.submits.length, 1); assert.equal(p.f.featureCommits, 1);
});
