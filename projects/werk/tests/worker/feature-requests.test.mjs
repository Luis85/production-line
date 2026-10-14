import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, rename, symlink, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { FeatureRequests } from '../../src/worker/dist/worker/application/feature-requests.js';
import { MarkdownFeatureFolder } from '../../src/worker/dist/worker/infrastructure/features/folder.js';
import { parseFeature, featureInput, featureTemplate } from '../../src/worker/dist/worker/infrastructure/features/document.js';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { WorkerSessions } from '../../src/worker/dist/worker/application/sessions.js';
import { LocalTaskboard } from '../../src/worker/dist/worker/application/local-tasks.js';
import { configuration } from '../../src/worker/dist/worker/config.js';
const source = (extra = '', body = '# Goal\n\nExplain the feature.\n') => '---\nschemaVersion: 1\ntitle: Feature request\nstatus: ready\n' + extra + '---\n' + body;
async function fixture(t, queue) {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'werk-features-'))), directory = join(project, 'features'), state = join(project, '.state');
  await mkdir(state); const tasks = new Map(), submissions = [];
  queue ??= { async submit(record) { if (!tasks.has(record.taskId)) { submissions.push(structuredClone(record)); tasks.set(record.taskId, { status: 'queued' }); } }, inspect(record) { return tasks.get(record.taskId); } };
  const folder = new MarkdownFeatureFolder(directory, state, 'codex-cli', project); const service = new FeatureRequests(folder, queue, 0); await service.init();
  t.after(async () => { await service.close(); await rm(project, { recursive: true, force: true }); });
  return { project, directory, state, folder, service, queue, tasks, submissions, put: (name, text) => writeFile(join(directory, name), text), read: async name => parseFeature(await readFile(join(directory, name), 'utf8')) };
}
async function scan(service) { await service.tick(true); await service.tick(true); }
test('feature configuration is opt-in and resolves relative to the project', async () => {
  assert.equal((await configuration({})).features, undefined);
  const project = resolve('feature-config-project');
  const configured = await configuration({ 'project-dir': project, 'features-dir': 'requests' }, { features: { provider: 'anthropic-api', pollMs: 500 } });
  assert.equal(configured.features.directory, join(project, 'requests')); assert.equal(configured.features.provider, 'anthropic-api');
  await assert.rejects(configuration({}, { features: { directory: 'features', pollMs: 1 } }));
});
test('template stays a draft; stable Markdown intake preserves body, comments and custom metadata', async t => {
  const f = await fixture(t); assert.equal(parseFeature(featureTemplate).data.status, 'draft');
  assert.equal(featureInput(parseFeature(featureTemplate), 'openai-api').provider, 'openai-api');
  assert.throws(() => parseFeature(source('id: remote-reserved\n')), /reserved/);
  await f.put('draft.md', featureTemplate); const body = '# Goal\r\n\r\nKeep my Markdown exactly.\r\n';
  await f.put('request.md', source('# Keep this comment\nlabels: [customer, important]\n', body));
  await f.service.tick(true); assert.equal(f.submissions.length, 0);
  await f.service.tick(true); assert.equal(f.submissions.length, 1);
  const result = await f.read('request.md'); assert.equal(result.body, body); assert.deepEqual(result.data.labels, ['customer', 'important']); assert.match(result.raw, /# Keep this comment/); assert.equal(result.data.status, 'queued'); assert.ok(result.data.id); assert.equal(result.data.werk.taskId, f.submissions[0].taskId);
  await scan(f.service); assert.equal(f.submissions.length, 1); assert.equal((await f.read('draft.md')).data.status, 'draft');
  await f.put('draft.md', featureTemplate.replace('status: draft', 'status: ready')); await scan(f.service); assert.equal(f.submissions.length, 2);
});
test('completion exports a readable result and rename/restart/edit never replays a request', async t => {
  const f = await fixture(t); await f.put('a.md', source()); await scan(f.service);
  const submitted = f.submissions[0]; f.tasks.set(submitted.taskId, { status: 'completed', text: 'Verified fixture result.' });
  await f.service.tick(true); let parsed = await f.read('a.md'); assert.equal(parsed.data.status, 'completed'); assert.match(await readFile(join(f.directory, parsed.data.werk.result), 'utf8'), /Verified fixture result/);
  await rename(join(f.directory, 'a.md'), join(f.directory, 'renamed.md')); await scan(f.service);
  await f.put('renamed.md', (await f.read('renamed.md')).raw.replace('Explain the feature.', 'Changed after acceptance.').replace('status: completed', 'status: ready')); await scan(f.service);
  parsed = await f.read('renamed.md'); assert.equal(parsed.data.werk.inputChanged, true); assert.equal(parsed.data.status, 'completed'); assert.equal(f.submissions.length, 1);
  await f.service.close(); const recovered = new FeatureRequests(new MarkdownFeatureFolder(f.directory, f.state, 'codex-cli', f.project), f.queue, 0); await recovered.init();
  try { await scan(recovered); assert.equal(f.submissions.length, 1); assert.equal(recovered.view().records[0].name, 'renamed.md'); } finally { await recovered.close(); }
});
test('capacity/configuration waits retain immutable input and recover a lost admission acknowledgement', async t => {
  let ready = false, calls = 0; const accepted = new Map();
  const queue = { async submit(record) { calls++; if (!ready) throw Error('Configure provider first.'); if (!accepted.has(record.taskId)) { accepted.set(record.taskId, { status: 'queued' }); throw Error('Acknowledgement interrupted.'); } }, inspect: record => accepted.get(record.taskId) };
  const f = await fixture(t, queue); await f.put('a.md', source()); await scan(f.service); assert.equal((await f.read('a.md')).data.status, 'waiting');
  await f.put('a.md', (await f.read('a.md')).raw.replace('Explain the feature.', 'Different input.')); ready = true; await scan(f.service);
  assert.equal(accepted.size, 1); assert.ok(calls >= 3); assert.equal(f.service.view().records[0].submitted, true); assert.equal((await f.read('a.md')).data.werk.inputChanged, true);
  const index = JSON.parse(await readFile(join(f.state, 'feature-index.json'), 'utf8')); assert.match(index.records[0].input.message, /Explain the feature/);
});
test('a failed private reservation write blocks admission until it is durably retried', async t => {
  const f = await fixture(t), save = f.folder.save.bind(f.folder); let writable = false;
  f.folder.save = async index => { if (!writable) throw Error('Injected index write failure.'); await save(index); };
  await f.put('a.md', source()); await scan(f.service); await scan(f.service);
  assert.equal(f.submissions.length, 0); assert.equal((await f.read('a.md')).data.id, undefined); assert.ok(f.service.view().error);
  writable = true; await scan(f.service); assert.equal(f.submissions.length, 1); assert.equal(f.service.view().error, null);
  const saved = JSON.parse(await readFile(join(f.state, 'feature-index.json'), 'utf8'));
  assert.equal(saved.records[0].taskId, f.submissions[0].taskId);
});
test('invalid YAML and duplicate IDs are visible without poisoning valid intake', async t => {
  const f = await fixture(t); await f.put('bad.md', source('title: duplicate\n')); await f.put('alias.md', source('extra: &a [hello]\ncopy: *a\n')); await f.put('one.md', source('id: duplicate-id\n')); await f.put('two.md', source('id: duplicate-id\n')); await f.put('good.md', source());
  await scan(f.service); assert.equal(f.submissions.length, 1); assert.equal(f.service.view().errors.length, 4); assert.match(await readFile(join(f.directory, '_worker-status.md'), 'utf8'), /Duplicate feature ID/);
  assert.equal(await readFile(join(f.directory, 'bad.md'), 'utf8'), source('title: duplicate\n'));
  await rm(join(f.directory, 'two.md')); await scan(f.service); assert.equal(f.submissions.length, 2);
});
test('orchestrator requests are written and tracked without entering the local submit path', async t => {
  const f = await fixture(t); const task = { id: 'remote-task', title: 'Assigned feature', criteria: ['Evidence'], attempt: 1 };
  await f.service.rememberRemote(task); f.tasks.set(task.id, { status: 'running' }); await scan(f.service);
  let parsed = await f.read('remote-remote-task.md'); assert.equal(parsed.data.source, 'orchestrator'); assert.equal(parsed.data.status, 'running'); assert.equal(f.submissions.length, 0);
  f.tasks.set(task.id, { status: 'completed', text: 'Simulated assignment evidence.' }); await f.service.tick(true); parsed = await f.read('remote-remote-task.md'); assert.equal(parsed.data.status, 'completed'); assert.equal(parsed.data.werk.attempt, 1);
  await f.service.rememberRemote({ ...task, attempt: 2 }); await f.service.tick(true); assert.equal((await f.read('remote-remote-task.md')).data.werk.attempt, 2); assert.equal(f.service.view().records.length, 1);
});
test('a missing request or deleted queue history never silently creates new work', async t => {
  const f = await fixture(t); await f.put('a.md', source()); await scan(f.service); await rm(join(f.directory, 'a.md'));
  await scan(f.service); assert.equal(f.submissions.length, 1); assert.match(await readFile(join(f.directory, '_worker-status.md'), 'utf8'), /File missing/);
  f.tasks.clear(); await scan(f.service); assert.equal(f.service.view().records[0].status, 'unavailable'); assert.equal(f.submissions.length, 1);
});
test('folder ownership and regular-file boundaries prevent a second consumer and symlink ingestion', async t => {
  const f = await fixture(t), otherState = join(f.project, 'other-state'); await mkdir(otherState);
  const other = new FeatureRequests(new MarkdownFeatureFolder(f.directory, otherState, 'codex-cli', f.project), f.queue, 0); await assert.rejects(other.init(), /locked/);
  await other.close(); await f.put('a.md', source()); await scan(f.service); assert.equal(f.submissions.length, 1);
  if (process.platform !== 'win32') { const outside = join(f.project, 'outside.md'); await writeFile(outside, source()); await symlink(outside, join(f.directory, 'linked.md')); await scan(f.service); assert.equal(f.submissions.length, 1); assert.match(f.service.view().errors[0].message, /regular file/); assert.equal(await readFile(outside, 'utf8'), source()); }
  await f.service.close(); await assert.rejects(other.init(), /another worker/); await other.close();
});
test('optimistic request updates refuse a newer editor save', async t => {
  const f = await fixture(t); await f.put('a.md', source()); const [observed] = await f.folder.scan();
  await f.put('a.md', source('', '# Newer draft\n'));
  assert.equal(await f.folder.update(observed, { id: 'request', source: 'folder', taskId: 'feature-request', sessionId: 'feature-request', status: 'queued' }, false), false);
  assert.match(await readFile(join(f.directory, 'a.md'), 'utf8'), /Newer draft/);
});
test('feature patch submission is idempotent and shares the serial executor with chat', async t => {
  const f = await fixture(t); let active = 0, maximum = 0, calls = 0;
  const model = () => ({ async reply(messages) { calls++; maximum = Math.max(maximum, ++active); await new Promise(r => setTimeout(r, 20)); active--; return messages[0].text.startsWith('Implement') ? JSON.stringify({ summary: 'Patch fixture', files: [{ path: 'new.txt', content: 'hello\n' }] }) : 'Chat fixture'; } });
  const settings = new WorkerSettings(f.state); await settings.init(); const sessions = new WorkerSessions(f.state, settings, model); await sessions.init(); const board = new LocalTaskboard(f.state, settings, sessions, model); await board.init();
  t.after(async () => { await board.close(); await sessions.close(); });
  await settings.update({ board: { paused: true } }); await sessions.start('Other task');
  const input = { title: 'Patch feature', instruction: 'Create approved file', repository: f.project, paths: ['new.txt'] }, submission = { id: 'feature-fixed', hash: 'a'.repeat(64) };
  await board.create(input, submission); await board.create(input, submission); assert.equal(board.view().tasks.length, 1);
  await assert.rejects(board.create(input, { ...submission, hash: 'b'.repeat(64) }), /different input/);
  await settings.update({ board: { paused: false } });
  for (let n = 0; n < 200; n++) { await board.tick(); if (board.detail(submission.id).status === 'review' && !sessions.busy) break; await new Promise(r => setTimeout(r, 10)); }
  assert.equal(board.detail(submission.id).status, 'review'); assert.equal(maximum, 1); assert.equal(calls, 2); await assert.rejects(readFile(join(f.project, 'new.txt')), { code: 'ENOENT' });
});
