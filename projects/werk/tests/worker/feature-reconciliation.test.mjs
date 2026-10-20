import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FeatureRequests } from '../../src/worker/dist/worker/application/feature-requests.js';
import { MarkdownFeatureFolder } from '../../src/worker/dist/worker/infrastructure/features/folder.js';
import { featureInput, parseFeature } from '../../src/worker/dist/worker/infrastructure/features/document.js';
import { featureTaskIdentity } from '../../src/worker/dist/worker/application/feature-markdown.js';
import { replaceFeatureFile } from '../../src/worker/dist/worker/infrastructure/features/recoverable-write.js';
const note = (intent = 'submit', text = 'Deliver the requested behavior.') => `---\nschema: worker.request/v1\nid: FR-0042\ntitle: Implement feature\nintent: ${intent}\npaths: [src/]\n---\n## Outcome\n\n${text}\n\n## Acceptance criteria\n\n- AC-01: The behavior works.\n`;
async function fixture(t) {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'werk-revisions-'))), directory = join(project, 'features'), state = join(project, '.state'); await mkdir(state);
  const records = new Map(), submissions = [], revisions = [], holds = [];
  let allowRevision = false;
  const queue = {
    async submit(record) { submissions.push(structuredClone(record)); records.set(record.taskId, { status: 'queued', priority: record.input.priority }); },
    inspect(record) { return records.get(record.taskId); },
    async reprioritize(record, priority) { const current = records.get(record.taskId); if (current?.status !== 'queued') return false; current.priority = priority; return true; },
    async source(record, issue) { holds.push({ id: record.id, issue }); },
    async revise(record, input, hash) { if (!allowRevision) return false; revisions.push({ id: record.id, input, hash }); return true; },
  };
  const folder = new MarkdownFeatureFolder(directory, state, 'claude-cli', project), service = new FeatureRequests(folder, queue, 0); await service.init();
  t.after(async () => { await service.close(); await rm(project, { recursive: true, force: true }); });
  return { project, directory, state, service, queue, folder, submissions, revisions, holds, records, allowRevision: () => { allowRevision = true; }, write: raw => writeFile(join(directory, 'request.md'), raw), scan: async () => { await service.tick(true); await service.tick(true); } };
}
test('draft and missing intent/status never dispatch; explicit legacy ready remains compatible', async t => {
  const f = await fixture(t); await f.write(note('draft')); await f.scan(); assert.equal(f.submissions.length, 0);
  await f.write(note().replace('intent: submit\n', '')); await f.scan(); assert.equal(f.submissions.length, 0); assert.match(f.service.view().errors[0].message, /intent/);
  await f.write('---\nschemaVersion: 1\ntitle: Legacy\n---\nAn unspecified request.'); await f.scan(); assert.equal(f.submissions.length, 0);
  await f.write('---\nschemaVersion: 1\ntitle: Legacy\nstatus: ready\n---\nAn explicitly ready request.'); await f.scan(); assert.equal(f.submissions.length, 1);
});
test('missing/invalid/duplicate source holds retained work and renames retain its identity', async t => {
  const f = await fixture(t); await f.write(note()); await f.scan(); assert.equal(f.submissions.length, 1);
  const source = await readFile(join(f.directory, 'request.md'), 'utf8');
  await writeFile(join(f.directory, 'duplicate.md'), source); await f.scan(); assert.equal(f.service.view().records[0].sourceIssue.code, 'duplicate_identity');
  await rm(join(f.directory, 'duplicate.md')); await f.write('broken'); await f.scan(); assert.equal(f.service.view().records[0].sourceIssue.code, 'invalid_source');
  await f.write(source); await f.scan(); assert.equal(f.service.view().records[0].sourceIssue, undefined);
  await rename(join(f.directory, 'request.md'), join(f.directory, 'renamed.md')); await f.scan(); assert.equal(f.service.view().records[0].name, 'renamed.md');
  await rm(join(f.directory, 'renamed.md')); await f.scan(); assert.equal(f.service.view().records[0].sourceIssue.code, 'missing_source'); assert.equal(f.submissions.length, 1);
});
test('material edits hold before safe revision, retain identity, and do not reopen terminal work', async t => {
  const f = await fixture(t); await f.write(note()); await f.scan(); const id = f.submissions[0].taskId;
  await f.write(note('submit', 'Deliver changed behavior.')); await f.scan(); assert.equal(f.service.view().records[0].sourceIssue.code, 'changed_input'); assert.equal(f.revisions.length, 0);
  f.allowRevision(); await f.scan(); assert.equal(f.revisions.length, 1); assert.equal(f.service.view().records[0].semanticRevision, 2); assert.equal(f.service.view().records[0].taskId, id);
  await f.scan(); assert.equal(f.revisions.length, 1);
  f.records.set(id, { status: 'cancelled' }); await f.scan(); await f.write(note('submit', 'Another changed requirement.')); await f.scan();
  assert.equal(f.revisions.length, 1); assert.equal(f.submissions.length, 1); assert.equal(f.service.view().records[0].status, 'cancelled');
});
test('guarded note replacement keeps displaced user content recoverable and rejects stale writes', async t => {
  const f = await fixture(t), path = join(f.directory, 'request.md'), recovery = join(f.directory, '_conflicts');
  await f.write(note('draft')); assert.equal(await replaceFeatureFile(path, 'stale', 'bad', recovery), false);
  assert.equal(await replaceFeatureFile(path, note('draft'), note('draft', 'Edited outcome.'), recovery), true);
  const snapshots = await readdir(recovery); assert.equal(snapshots.length, 1); assert.equal(await readFile(join(recovery, snapshots[0]), 'utf8'), note('draft'));
  assert.match(await readFile(path, 'utf8'), /Edited outcome/);
});


test('browser intake persists one canonical source and keeps its original polling identity through replay', async t => {
  const f = await fixture(t), markdown = note().replace('FR-0042', 'ui-request');
  const input = featureInput(parseFeature(markdown), 'claude-cli');
  const receipt = await f.service.publishInteraction('ui-request', input, markdown);
  assert.deepEqual(receipt, { name: 'interaction-ui-request.md', taskId: 'ui-request', sessionId: 'local-ui-request' });
  await f.scan(); assert.equal(f.submissions.length, 1); assert.equal(f.submissions[0].taskId, 'ui-request');
  assert.deepEqual(await f.service.publishInteraction('ui-request', input, markdown), receipt);
  await f.scan(); assert.equal(f.submissions.length, 1);
  const changed = markdown.replace('requested behavior', 'different behavior');
  await assert.rejects(f.service.publishInteraction('ui-request', featureInput(parseFeature(changed), 'claude-cli'), changed), /different input/);
  await rm(join(f.directory, receipt.name));
  await assert.rejects(f.service.publishInteraction('ui-request', input, markdown), /missing/);
});

test('portable execution IDs preserve uppercase identity without merging differently cased requests', () => {
  const upper = featureTaskIdentity('FR-0042', 'patch'), lower = featureTaskIdentity('fr-0042', 'patch');
  assert.match(upper.taskId, /^[a-z0-9-]{1,90}$/); assert.notEqual(upper.taskId, lower.taskId);
  assert.deepEqual(featureTaskIdentity('existing-id', 'chat'), { taskId: 'feature-existing-id', sessionId: 'feature-existing-id' });
});


test('priority-only edits reorder queued requests without revising input or dispatching again', async t => {
  const f = await fixture(t);
  await f.write(note());
  await writeFile(join(f.directory, 'second.md'), note().replace('FR-0042', 'FR-0043').replace('intent: submit', 'intent: submit\npriority: high'));
  await f.scan();
  const first = f.submissions.find(record => record.id === 'FR-0042'), second = f.submissions.find(record => record.id === 'FR-0043');
  const order = () => [...f.records.entries()].sort((a, b) => b[1].priority - a[1].priority).map(([id]) => id);
  assert.deepEqual(order(), [second.taskId, first.taskId]);
  await f.write((await readFile(join(f.directory, 'request.md'), 'utf8')).replace('intent: submit', 'intent: submit\npriority: urgent'));
  await f.scan();
  assert.deepEqual(order(), [first.taskId, second.taskId]);
  assert.equal(f.submissions.length, 2); assert.equal(f.revisions.length, 0);
  const projected = f.service.view().records.find(record => record.id === 'FR-0042');
  assert.equal(projected.semanticRevision, 1); assert.equal(projected.inputHash, first.inputHash); assert.equal(projected.priority, 3);
  assert.equal((await f.service.list()).files.find(file => file.id === 'FR-0042').priority, 3);
  f.records.get(first.taskId).status = 'running';
  await f.write((await readFile(join(f.directory, 'request.md'), 'utf8')).replace('priority: urgent', 'priority: low')); await f.scan();
  assert.equal(f.records.get(first.taskId).priority, 3, 'Running execution retains its already-applied queue priority.');
});

test('repeated scans re-read bytes and provider context without exposing cached object mutations', async t => {
  const f = await fixture(t); await f.write(note('draft'));
  const first = await f.folder.scan(); first[0].input.title = 'Mutated by caller';
  assert.equal((await f.folder.scan())[0].input.title, 'Implement feature');
  await f.write(note('draft').replace('Implement feature', 'Different feature'));
  assert.equal((await f.folder.scan())[0].input.title, 'Different feature');
  await f.write('invalid source'); assert.match((await f.folder.scan())[0].error, /frontmatter/);
  await rm(join(f.directory, 'request.md')); assert.deepEqual(await f.folder.scan(), []);
  await f.write(note('draft'));
  let provider = 'claude-cli';
  const folder = new MarkdownFeatureFolder(f.directory, f.state, () => provider, f.project);
  assert.equal((await folder.scan())[0].input.provider, 'claude-cli');
  provider = 'codex-cli'; assert.equal((await folder.scan())[0].input.provider, 'codex-cli');
});
