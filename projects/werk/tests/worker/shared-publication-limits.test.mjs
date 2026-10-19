import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedFeaturePublicationIssue, sharedFeaturePublicationLimits } from '../../src/worker/dist/worker/application/shared-feature-publication-limits.js';
import { fixture, source, sourcePath } from './shared-feature-fixture.mjs';

const patch = count => Array.from({ length: count }, (_, index) => `diff --git a/src/file-${index}.ts b/src/file-${index}.ts
new file mode 100644
--- /dev/null
+++ b/src/file-${index}.ts
@@ -0,0 +1 @@
+export const value = ${index};
`).join('');
const oversized = 'diff --git a/src/file.ts b/src/file.ts\n' + 'é'.repeat(65536);

test('shared publication preflight measures UTF-8 bytes and actual Git file headers at the existing bounds', () => {
  assert.deepEqual(sharedFeaturePublicationLimits, { patchMaxBytes: 131072, changedFilesMax: 32 });
  assert.equal(sharedFeaturePublicationIssue('a'.repeat(131072)), undefined);
  assert.match(sharedFeaturePublicationIssue('a'.repeat(131073)), /131,073 bytes.*131,072 bytes/);
  assert.ok(oversized.length < 131072);
  assert.match(sharedFeaturePublicationIssue(oversized), /128 KiB/);
  assert.equal(sharedFeaturePublicationIssue(patch(32)), undefined);
  assert.match(sharedFeaturePublicationIssue(patch(33)), /changes 33 files.*32 changed files/);
  assert.equal(sharedFeaturePublicationIssue(patch(1) + '+diff --git a/content b/content\n'.repeat(40)), undefined, 'added content is not a Git file header');
});

/** @type {Array<[string, string, RegExp]>} */
const cases = [
  ['too many changed files', patch(33), /changes 33 files/],
  ['too many patch bytes', oversized, /128 KiB/],
];
for (const [label, candidate, reason] of cases) test(`${label} publishes a durable blocked Task without starting or retrying feature publication`, async t => {
  const f = await fixture(t, { source: source.replace('  - src/navigation.ts', '  - src/') });
  await f.intake.sync(); await f.complete();
  f.controls.inspect = execution => ({ ...execution, patch: candidate });
  const taskId = f.intake.view().requests[0].taskId;
  const accepted = structuredClone((await f.state()).records[0].accepted);
  const request = structuredClone(f.requests.get(f.tasks.get(taskId).requestId));
  await f.intake.sync();
  let row = f.intake.view().requests[0];
  assert.equal(row.status, 'blocked'); assert.equal(row.publication, 'synced'); assert.match(row.error, reason);
  assert.equal(f.patchAttempts.length, 0); assert.equal(f.featureCommits, 0); assert.equal(f.primaryExecutions, 1);
  const remote = f.repositories.get('shared'), markdown = remote.files.get(row.taskNote);
  assert.match(markdown, /type: Task/); assert.match(markdown, /status: blocked/); assert.match(markdown, reason);
  assert.match(markdown, /results are retained.*maintainer.*smaller successor Feature Requests/);
  assert.doesNotMatch(markdown, /The worker will retry publication/);
  assert.match(remote.files.get(sourcePath), /status: blocked/);
  assert.match(remote.files.get(sourcePath), /Follow the diagnostic Task/);
  const note = row.taskNote, writes = f.lifecycleAttempts.length;
  await f.intake.sync(); await f.restart(); await f.intake.sync();
  row = f.intake.view().requests[0];
  assert.equal(row.status, 'blocked'); assert.equal(row.publication, 'synced'); assert.equal(row.taskNote, note);
  assert.equal(f.lifecycleAttempts.length, writes, 'polling and restart acknowledge the same diagnostic without rewriting it');
  assert.equal(f.patchAttempts.length, 0); assert.equal(f.submits.length, 1); assert.equal(f.primaryExecutions, 1);
  assert.deepEqual((await f.state()).records[0].accepted, accepted, 'the accepted scope remains frozen');
  assert.deepEqual(f.requests.get(request.id), request, 'the verified model result remains unchanged');
});

test('lost blocked-note acknowledgement recovers the same diagnostic without publishing a feature or rerunning the model', async t => {
  const f = await fixture(t); await f.intake.sync(); await f.complete();
  f.controls.inspect = execution => ({ ...execution, patch: oversized });
  f.controls.claimAckBlocked = true;
  await f.intake.sync();
  const pending = (await f.state()).records[0], remote = f.repositories.get('shared');
  assert.equal(pending.status, 'blocked'); assert.equal(pending.publication, 'error'); assert.ok(pending.pending);
  assert.ok(remote.files.has(pending.taskNote), 'the lost acknowledgement may already have published the Task');
  const taskNotes = [...remote.files].filter(([path]) => path.startsWith('feature-tasks/'));
  const operation = pending.pending.operationId, attempts = f.lifecycleAttempts.filter(write => write.operationId === operation).length;
  await f.restart(); f.controls.claimAckBlocked = false; await f.intake.sync();
  const row = f.intake.view().requests[0];
  assert.equal(row.status, 'blocked'); assert.equal(row.publication, 'synced'); assert.equal(row.taskNote, pending.taskNote);
  assert.equal(f.lifecycleAttempts.filter(write => write.operationId === operation).length, attempts + 1, 'recovery replays the exact durable outbox');
  assert.deepEqual([...remote.files].filter(([path]) => path.startsWith('feature-tasks/')), taskNotes, 'recovery preserves the diagnostic and earlier notes without creating another artifact');
  assert.equal(f.patchAttempts.length, 0); assert.equal(f.submits.length, 1); assert.equal(f.primaryExecutions, 1);
});
