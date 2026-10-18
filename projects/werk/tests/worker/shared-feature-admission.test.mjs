import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { sharedFeatureAdmissionHold } from '../../src/worker/dist/worker/status/workspace-feature-admission.js';
import { fixture, source, sourcePath } from './shared-feature-fixture.mjs';

/** @type {import('../../src/worker/dist/worker/application/shared-feature-state.js').SharedAdmissionHold} */
const capacityHold = { code: 'capacity', message: 'The worker queue is full. This ready request will be checked again automatically when a local queue place becomes available.' };
const frontmatter = markdown => parse(/^---\n([\s\S]*?)\n---\n/.exec(markdown)[1]);
const occupancy = f => [...f.tasks.values()].filter(task => ['queued', 'running'].includes(task.status)).length;

function workspace() {
  return {
    acceptingTasks: true, configurationUpdating: false, repositoriesUpdating: false,
    executionProfiles: { pending: () => false },
    settings: { value: { board: { paused: false, queueCapacity: 2 } } },
    board: { active: 0 }, sessions: { chatActive: 0 },
    consumption: {
      /** @returns {Pick<import('../../src/worker/dist/worker/application/consumption.js').ConsumptionStatus, 'blocked'|'reason'|'periodEnd'>} */
      status: () => ({ blocked: false, reason: 'available', periodEnd: '2026-10-19T00:00:00.000Z' }),
    },
  };
}

test('shared admission uses authoritative board occupancy plus chat work and waits below a lowered limit', () => {
  const w = workspace();
  assert.equal(sharedFeatureAdmissionHold(w), undefined);
  w.board.active = 1; w.sessions.chatActive = 1;
  assert.deepEqual(sharedFeatureAdmissionHold(w), capacityHold);
  w.settings.value.board.queueCapacity = 1;
  assert.equal(sharedFeatureAdmissionHold(w).code, 'capacity');
  w.board.active = 0; w.sessions.chatActive = 0;
  assert.equal(sharedFeatureAdmissionHold(w), undefined);
});

test('shared admission explains pause, configuration, shutdown and known UTC allowance boundaries truthfully', () => {
  const w = workspace();
  w.settings.value.board.paused = true; assert.equal(sharedFeatureAdmissionHold(w).code, 'paused');
  w.configurationUpdating = true; assert.equal(sharedFeatureAdmissionHold(w).code, 'configuration');
  w.configurationUpdating = false; w.repositoriesUpdating = true; assert.equal(sharedFeatureAdmissionHold(w).code, 'configuration');
  w.repositoriesUpdating = false; w.executionProfiles.pending = () => true; assert.equal(sharedFeatureAdmissionHold(w).code, 'configuration');
  w.acceptingTasks = false; assert.equal(sharedFeatureAdmissionHold(w).code, 'stopping');
  w.acceptingTasks = true; w.executionProfiles.pending = () => false; w.settings.value.board.paused = false;
  for (const reason of /** @type {const} */ (['exhausted', 'insufficient_reservation', 'unmeasured_usage'])) {
    w.consumption.status = () => ({ blocked: true, reason, periodEnd: '2026-10-19T00:00:00.000Z' });
    const hold = sharedFeatureAdmissionHold(w);
    assert.equal(hold.code, 'budget'); assert.equal(hold.resumesAt, '2026-10-19T00:00:00.000Z');
    assert.match(hold.message, /automatically/); assert.match(hold.message, /2026-10-19T00:00:00.000Z/);
  }
  w.consumption.status = () => ({ blocked: true, reason: 'accounting_unavailable', periodEnd: '2026-10-19T00:00:00.000Z' });
  assert.equal(sharedFeatureAdmissionHold(w).resumesAt, undefined, 'storage failure is not fixed by a new allowance window');
  assert.match(sharedFeatureAdmissionHold(w).message, /Repair/);
});

test('a ready batch stays unclaimed beyond capacity and drains past waiting, failed and invalid requests', async t => {
  const f = await fixture(t);
  f.commitFiles('shared', {
    'features/invalid.md': source.replace('shared-navigation', 'invalid-request').replace('- Arrow keys move the active selection.', '- TODO'),
    'features/second.md': source.replace('shared-navigation', 'second-request'),
    'features/third.md': source.replace('shared-navigation', 'third-request'),
  });
  f.controls.admissionHold = () => occupancy(f) >= 1 ? capacityHold : undefined;
  await f.intake.sync();
  assert.equal(f.tasks.size, 1); assert.equal((await f.state()).records.length, 1);
  const repo = f.repositories.get('shared');
  for (const name of ['second', 'third']) {
    const note = f.intake.view().requests.find(item => item.id === name + '-request');
    assert.equal(note.status, 'ready'); assert.equal(note.owner, null); assert.equal(note.ready.passed, true);
    assert.equal(frontmatter(repo.files.get(note.taskNote)).status, 'waiting');
    assert.doesNotMatch(repo.files.get('features/' + name + '.md'), /owner:/);
  }
  const writes = f.lifecycleAttempts.length;
  await f.intake.sync(); assert.equal(f.lifecycleAttempts.length, writes, 'unchanged holds do not churn Git commits');
  [...f.tasks.values()][0].status = 'waiting_input';
  await f.intake.sync(); assert.equal(f.tasks.size, 2);
  assert.equal(f.intake.view().requests.find(item => item.id === 'invalid-request').status, 'needs_rework');
  [...f.tasks.values()][1].status = 'failed';
  await f.intake.sync(); assert.equal(f.tasks.size, 3);
  const holdNotes = [...repo.files.values()].filter(value => value.includes('kind: intake-diagnostic') && value.includes('sourcePath: features/second.md'));
  assert.equal(holdNotes.length, 1); assert.equal(frontmatter(holdNotes[0]).status, 'resolved');
  await f.restart(); await f.intake.sync();
  assert.equal(f.tasks.size, 3); assert.equal(new Set(f.submits).size, 3);
});

test('hold notes are informational, stable across restart and preserve teammate edits', async t => {
  const f = await fixture(t); f.controls.admissionHold = () => capacityHold;
  await f.intake.sync();
  const note = f.intake.view().requests[0], repo = f.repositories.get('shared'), markdown = repo.files.get(note.taskNote);
  assert.match(markdown, /no answer in this Task is needed/);
  assert.match(markdown, /has not been claimed/); assert.equal(repo.files.get(sourcePath), source);
  const writes = f.lifecycleAttempts.length;
  await f.restart(); await f.intake.sync(); assert.equal(f.lifecycleAttempts.length, writes);
  f.commitFiles('shared', { [note.taskNote]: markdown + '\nTeam comment to preserve.\n' });
  await f.intake.sync(); assert.equal(f.tasks.size, 0);
  assert.match(repo.files.get(note.taskNote), /Team comment to preserve/);
  assert.match(f.intake.view().error, /Task was edited/);
});

test('capacity that fills during diagnostic publication is checked again before a remote claim', async t => {
  const f = await fixture(t);
  const gate = f.blockNextDiagnosticRead();
  const synchronization = f.intake.sync();
  await gate.entered;
  f.controls.admissionHold = () => capacityHold;
  gate.release(); await synchronization;
  assert.equal((await f.state()).records.length, 0); assert.equal(f.tasks.size, 0);
  assert.equal(f.repositories.get('shared').files.get(sourcePath), source);
  assert.equal(f.intake.view().requests[0].status, 'ready');
});


test('the 100-owned history bound keeps additional requests ready and retains existing provenance', async t => {
  const f = await fixture(t);
  const edits = Object.fromEntries(Array.from({ length: 100 }, (_, index) => ['features/request-' + index + '.md', source.replace('shared-navigation', 'request-' + index)]));
  f.commitFiles('shared', edits);
  await f.intake.sync();
  const before = await f.state();
  assert.equal(before.records.length, 100); assert.equal(f.tasks.size, 100);
  const held = f.intake.view().requests.find(item => item.owner === null && item.ready?.passed);
  assert.ok(held); assert.equal(held.status, 'ready');
  const markdown = f.repositories.get('shared').files.get(held.taskNote);
  assert.equal(frontmatter(markdown).hold.code, 'history_capacity');
  assert.match(markdown, /Preserve this worker state/);
  await f.intake.sync();
  assert.deepEqual((await f.state()).records.map(record => record.id), before.records.map(record => record.id));
  assert.equal(f.tasks.size, 100);
});


test('a budget hold retains its UTC boundary, can recur after another hold and resolves before claim', async t => {
  const f = await fixture(t), w = workspace();
  w.consumption.status = () => ({ blocked: true, reason: 'exhausted', periodEnd: '2026-10-19T00:00:00.000Z' });
  f.controls.admissionHold = () => sharedFeatureAdmissionHold(w);
  await f.intake.sync();
  const repo = f.repositories.get('shared'), notePath = f.intake.view().requests[0].taskNote;
  const budgetMarkdown = repo.files.get(notePath);
  assert.equal(frontmatter(budgetMarkdown).hold.resumesAt, '2026-10-19T00:00:00.000Z');
  const writes = f.lifecycleAttempts.length;
  await f.intake.sync(); assert.equal(f.lifecycleAttempts.length, writes);
  w.settings.value.board.paused = true;
  await f.intake.sync(); assert.equal(frontmatter(repo.files.get(notePath)).hold.code, 'paused');
  w.settings.value.board.paused = false;
  await f.intake.sync(); assert.equal(repo.files.get(notePath), budgetMarkdown);
  assert.equal(f.tasks.size, 0); assert.equal(repo.files.get(sourcePath), source);
  w.consumption.status = () => ({ blocked: false, reason: 'available', periodEnd: '2026-10-19T00:00:00.000Z' });
  await f.intake.sync(); assert.equal(f.tasks.size, 1);
  const resolved = frontmatter(repo.files.get(notePath));
  assert.equal(resolved.status, 'resolved'); assert.equal(resolved.hold, undefined);
});
