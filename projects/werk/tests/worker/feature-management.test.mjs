import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FeatureRequests } from '../../src/worker/dist/worker/application/feature-requests.js';
import { MarkdownFeatureFolder } from '../../src/worker/dist/worker/infrastructure/features/folder.js';
const draft = '---\nschemaVersion: 1\ntitle: CLI request\nstatus: draft\n# preserve comment\n---\n# Goal\n\nExplain the feature.\n';
async function fixture(t, blocked = false) {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'werk-management-'))), directory = join(project, 'features'), state = join(project, '.state'); await mkdir(state);
  const tasks = new Map(); let submits = 0;
  const queue = { async submit(record) { submits++; if (blocked) throw Error('Provider unavailable'); tasks.set(record.taskId, { status: 'queued' }); }, inspect: record => tasks.get(record.taskId), async control(record, action) { const task = tasks.get(record.taskId); if (action === 'retry' && !['failed', 'cancelled'].includes(task.status)) throw Error('Cannot retry'); task.status = action === 'cancel' ? 'cancelled' : 'queued'; } };
  const service = new FeatureRequests(new MarkdownFeatureFolder(directory, state, 'codex-cli', project), queue, 0); await service.init();
  t.after(async () => { await service.close(); await rm(project, { recursive: true, force: true }); });
  return { service, tasks, directory, project, submits: () => submits, action: (action, extra = {}) => service.action({ action, name: 'request.md', ...extra }), scan: async () => { await service.tick(true); await service.tick(true); } };
}
test('draft CRUD, explicit submission and same-task controls preserve identity and Markdown', async t => {
  const f = await fixture(t); let file = await f.action('create', { markdown: draft }); assert.equal(file.markdown, draft);
  assert.equal((await f.service.list()).files[0].status, 'draft'); assert.equal(f.submits(), 0);
  await assert.rejects(f.action('create', { markdown: draft }), /already exists/);
  await assert.rejects(f.action('edit', { revision: 'old', markdown: draft }), /revision/);
  file = await f.action('edit', { revision: file.revision, markdown: draft.replace('Explain', 'Describe') });
  assert.equal((await f.action('validate')).valid, true);
  file = await f.action('submit', { revision: file.revision }); assert.match(file.markdown, /status: ready/); assert.equal((await f.action('result')).execution.status, 'ready'); await f.scan();
  file = await f.action('get'); const id = file.record.taskId; assert.equal(f.submits(), 1);
  assert.match(file.markdown, /# preserve comment/); await assert.rejects(f.action('edit', { revision: file.revision, markdown: draft }), /frozen/);
  await assert.rejects(f.action('delete', { revision: file.revision }), /Cancel or finish/);
  file = await f.action('cancel', { revision: file.revision }); assert.equal(file.record.status, 'cancelled');
  file = await f.action('retry', { revision: file.revision }); assert.equal(file.record.taskId, id); assert.equal(file.record.status, 'queued'); assert.equal(f.submits(), 1);
  f.tasks.set(id, { status: 'completed', text: 'Evidence', patch: 'fixture patch' }); await f.scan();
  assert.equal((await f.action('result')).execution.text, 'Evidence'); file = await f.action('get');
  f.tasks.set(id, { status: 'running' });
  await assert.rejects(f.action('archive', { revision: file.revision }), /Cancel or finish/);
  await assert.rejects(f.action('delete', { revision: file.revision }), /Cancel or finish/);
  f.tasks.set(id, { status: 'completed', text: 'Evidence' });
  file = await f.action('archive', { revision: file.revision }); assert.equal(file.record.archived, true);
  file = await f.action('restore', { revision: file.revision }); assert.equal(file.record.archived, false);
  await f.action('delete', { revision: file.revision }); await f.scan(); assert.equal(f.submits(), 1);
  await assert.rejects(f.action('create', { markdown: draft }), /retained request/);
});
test('waiting intake can be cancelled durably and explicitly retried', async t => {
  const f = await fixture(t, true); let file = await f.action('create', { markdown: draft }); await f.action('submit', { revision: file.revision }); await f.scan();
  file = await f.action('get'); assert.equal(file.record.status, 'waiting');
  file = await f.action('cancel', { revision: file.revision }); const before = f.submits(); await f.scan(); assert.equal(f.submits(), before);
  await f.action('retry', { revision: file.revision }); await f.scan(); assert.ok(f.submits() > before);
});
test('invalid drafts can be inspected/repaired or deleted; traversal, symlinks and remote ownership are rejected', async t => {
  const f = await fixture(t); await assert.rejects(f.service.action({ action: 'create', name: '../outside.md', markdown: draft }));
  await writeFile(join(f.directory, 'request.md'), 'invalid'); let file = await f.action('get');
  await assert.rejects(f.action('validate'), /frontmatter/); file = await f.action('edit', { revision: file.revision, markdown: draft }); await f.action('delete', { revision: file.revision });
  await writeFile(join(f.directory, 'request.md'), 'invalid'); file = await f.action('get'); await f.action('delete', { revision: file.revision });
  if (process.platform !== 'win32') { const path = join(f.project, 'outside.md'); await writeFile(path, draft); await symlink(path, join(f.directory, 'request.md')); await assert.rejects(f.action('get'), /regular file/); assert.equal(await readFile(path, 'utf8'), draft); }
  await f.service.rememberRemote({ id: 'assignment', title: 'Remote', criteria: ['Evidence'], attempt: 1 });
  const remote = await f.service.action({ action: 'get', name: 'remote-assignment.md' });
  await assert.rejects(f.service.action({ action: 'cancel', name: remote.name, revision: remote.revision }), /orchestrator-owned/);
});

test('cancellation reaches a task whose admission acknowledgement was lost', async t => {
  const f = await fixture(t, true); let file = await f.action('create', { markdown: draft });
  await f.action('submit', { revision: file.revision }); await f.scan(); file = await f.action('get');
  f.tasks.set(file.record.taskId, { status: 'queued' });
  file = await f.action('cancel', { revision: file.revision });
  assert.equal(file.record.submitted, true); assert.equal(f.tasks.get(file.record.taskId).status, 'cancelled');
  await assert.rejects(f.service.action({ action: 'create', name: 'duplicate.md', markdown: draft.replace('status: draft', 'status: draft\nid: ' + file.record.id) }), /already retained/);
});
