import { cleanup } from './fixture-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { commands } from '../../scripts/runtime/portable/commands.mjs';
import { workerBody } from '../../scripts/runtime/portable/worker-commands.mjs';
import { FeatureRequests } from '../../src/worker/dist/worker/application/feature-requests.js';
import { MarkdownFeatureFolder } from '../../src/worker/dist/worker/infrastructure/features/folder.js';
import { assertPublicationPath } from '../../src/worker/dist/worker/infrastructure/features/git-io.js';
import { SharedIntakeRuntime } from '../../src/worker/dist/worker/infrastructure/features/shared-intake-runtime.js';

const catalog = commands('worker');

test('shared intake has first-class status, sync and guarded configure commands', async () => {
  assert.deepEqual([catalog['shared status'].method, catalog['shared status'].path], ['GET', '/api/shared-intake']);
  assert.equal(catalog['shared status'].mutating, undefined);
  assert.equal(await workerBody(catalog['shared status'], undefined, {}), undefined);
  assert.equal(catalog['shared sync'].mutating, true);
  assert.deepEqual(await workerBody(catalog['shared sync'], undefined, {}), { action: 'sync' });
  assert.equal(catalog['shared configure'].body, true);
  assert.equal(catalog['shared configure'].mutating, true);
  const config = { enabled: true, repositoryId: 'local-project', remote: 'origin', branch: 'iteration/2026-KW42', workflowPath: '.werk/feature-workflow.json', pollMs: 60000 };
  assert.deepEqual(await workerBody(catalog['shared configure'], { expectedRevision: 3, config }, {}), { action: 'configure', expectedRevision: 3, config });
  await assert.rejects(workerBody(catalog['shared configure'], { action: 'sync' }, {}), /come from the command/);
});

async function folderFixture(t, retained) {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'werk-shared-guard-'))), directory = join(project, 'requests'), state = join(project, '.state');
  await mkdir(state); await mkdir(directory);
  if (retained) await writeFile(join(state, 'feature-index.json'), JSON.stringify({ version: 1, owner: 'saved-worker', records: [retained] }));
  const submissions = [], controls = [], tasks = new Map();
  if (retained?.submitted) tasks.set(retained.taskId, { status: 'queued' });
  const queue = {
    async submit(record) { submissions.push(structuredClone(record)); tasks.set(record.taskId, { status: 'queued' }); },
    inspect(record) { return tasks.get(record.taskId); },
    async control(record, action) { controls.push(action); tasks.set(record.taskId, { status: action === 'cancel' ? 'cancelled' : 'queued' }); },
  };
  const folder = new MarkdownFeatureFolder(directory, state, 'claude-cli', project);
  let service = new FeatureRequests(folder, queue, 0); await service.init();
  cleanup(t, async () => { await service.close(); await rm(project, { recursive: true, force: true }); });
  return { directory, state, folder, get service() { return service; }, submissions, controls,
    async restart() { await service.close(); service = new FeatureRequests(new MarkdownFeatureFolder(directory, state, 'claude-cli', project), queue, 0); await service.init(); },
  };
}
const sharedId = 'fr-5c8c2981-7c51-4fe2-9eb3-3475020bc0d4';
const shared = '---\nschemaVersion: 1\ntemplateId: feature-request-v1\nid: ' + sharedId + '\ntitle: Shared request\nstatus: ready\nmode: patch\npaths:\n  - docs/a.md\n---\n# Goal\n\nChange a.\n';
const retainedRecord = submitted => ({ id: sharedId, name: 'shared.md', source: 'folder', taskId: 'feature-' + sharedId, sessionId: 'local-feature-' + sharedId,
  input: { title: 'Shared request', mode: 'patch', provider: 'claude-cli', message: '# Goal\n\nChange a.', paths: ['docs/a.md'], priority: 1 },
  inputHash: 'saved-input', submitted, status: submitted ? 'queued' : 'waiting', createdAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T10:00:00Z',
});

test('local folder intake leaves shared Git requests untouched and says how to process them', async t => {
  const f = await folderFixture(t), path = join(f.directory, 'shared.md');
  await writeFile(path, shared);
  for (let i = 0; i < 3; i++) await f.service.tick(true);
  assert.equal(f.submissions.length, 0);
  assert.equal(await readFile(path, 'utf8'), shared, 'no lifecycle metadata was written into the team file');
  assert.match(JSON.stringify(f.service.view().errors), /Shared Git request: connect shared intake/);
  await writeFile(join(f.directory, 'local.md'), '---\nschemaVersion: 1\ntitle: Local request\nstatus: ready\n---\n# Goal\n\nExplain.\n');
  await f.service.tick(true); await f.service.tick(true);
  assert.equal(f.submissions.length, 1); assert.equal(f.submissions[0].name, 'local.md');
});

test('incomplete shared drafts bypass local validation and cannot be submitted locally', async t => {
  const f = await folderFixture(t), path = join(f.directory, 'draft.md');
  const draft = shared.replace('status: ready', 'status: draft').replace('title: Shared request', 'title: ""').replace('paths:\n  - docs/a.md', 'paths: []');
  await writeFile(path, draft);
  await f.service.tick(true); await f.service.tick(true);
  assert.equal(f.submissions.length, 0); assert.deepEqual(f.service.view().errors, []);
  const file = await f.service.action({ action: 'get', name: 'draft.md' });
  await assert.rejects(f.service.action({ action: 'submit', name: 'draft.md', revision: file.revision }), /Shared Git requests use shared intake/);
  assert.equal(await readFile(path, 'utf8'), draft);
});

for (const marker of ['""', '123', 'null', '[]']) test('shared marker presence blocks local execution even with templateId: ' + marker, async t => {
  const f = await folderFixture(t), path = join(f.directory, 'shared.md'), markdown = shared.replace('templateId: feature-request-v1', 'templateId: ' + marker);
  await writeFile(path, markdown);
  await f.service.tick(true); await f.service.tick(true);
  assert.equal(f.submissions.length, 0);
  assert.equal(await readFile(path, 'utf8'), markdown);
  assert.match(JSON.stringify(f.service.view().errors), /Shared Git request: connect shared intake/);
});

for (const submitted of [false, true]) test('an upgraded worker quarantines a retained ' + (submitted ? 'submitted' : 'waiting') + ' shared request without losing cancellation or history', async t => {
  const retained = retainedRecord(submitted), f = await folderFixture(t, retained), path = join(f.directory, 'shared.md');
  const markdown = shared.replace('status: ready', 'status: ' + retained.status);
  await writeFile(path, markdown);
  await f.service.tick(true); await f.service.tick(true);
  assert.equal(f.submissions.length, 0);
  assert.equal(await readFile(path, 'utf8'), markdown);
  assert.match(JSON.stringify(f.service.view().errors), /retained local history.*Cancel any unfinished local task/);
  let file = await f.service.action({ action: 'get', name: 'shared.md' });
  assert.equal(file.record.taskId, retained.taskId);
  await assert.rejects(f.service.action({ action: 'retry', name: 'shared.md', revision: file.revision }), /Shared Git requests use shared intake/);
  await f.service.action({ action: 'cancel', name: 'shared.md', revision: file.revision });
  assert.deepEqual(f.controls, submitted ? ['cancel'] : []);
  assert.equal(await readFile(path, 'utf8'), markdown);
  await f.restart(); await f.service.tick(true);
  file = await f.service.action({ action: 'get', name: 'shared.md' });
  assert.equal(file.record.taskId, retained.taskId); assert.equal(file.record.status, 'cancelled');
  await assert.rejects(f.service.action({ action: 'retry', name: 'shared.md', revision: file.revision }), /Shared Git requests use shared intake/);
  assert.equal(f.submissions.length, 0); assert.equal(await readFile(path, 'utf8'), markdown);
});

test('the local file adapter refuses lifecycle writes into a shared note', async t => {
  const f = await folderFixture(t), path = join(f.directory, 'shared.md');
  await writeFile(path, shared);
  const [file] = await f.folder.scan();
  assert.equal(await f.folder.update(file, retainedRecord(false), false), false);
  assert.equal(await readFile(path, 'utf8'), shared);
});

test('Windows publication preflight uses Windows paths and reports the actual violated limits', () => {
  const repository = 'C:\\Projects\\PMO.Trumpf.LACForce', key = 'a'.repeat(64);
  assert.doesNotThrow(() => assertPublicationPath(win32.join(repository, '.werk', 'worker', 'shared-git', key), repository, 'win32'));
  // Same-drive relative metadata is short; only the absolute character limit fails.
  const deepRepository = 'C:\\' + 'x'.repeat(190), deep = win32.join(deepRepository, '.werk', 'worker', 'shared-git', key);
  assert.throws(() => assertPublicationPath(deep, deepRepository, 'win32'), error => {
    assert.equal(error.code, 'invalid_input');
    assert.match(error.message, /absolute metadata path has \d+ characters.*fewer than 260/);
    assert.doesNotMatch(error.message, /220/);
    assert.ok(error.message.includes('C:\\werk\\project'));
    return true;
  });
  // Different drives prevent a relative argument; multibyte names hit Git's byte bound first.
  const unicodeState = 'D:\\' + 'é'.repeat(105);
  assert.throws(() => assertPublicationPath(unicodeState, repository, 'win32'), error => {
    assert.match(error.message, /Git worktree argument uses \d+ UTF-8 bytes.*at most 220/);
    assert.doesNotMatch(error.message, /260/);
    return true;
  });
  assert.doesNotThrow(() => assertPublicationPath(deep, deepRepository, 'linux'));
});

test('Windows shared configuration rejects an overlong publication path without saving a binding or claiming work', { skip: process.platform !== 'win32' && 'Windows filesystem integration' }, async t => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'werk-preflight-'))), state = join(project, 'x'.repeat(160)), calls = [];
  await mkdir(state);
  const runtime = new SharedIntakeRuntime({ stateDirectory: state, resolve: () => ({ path: project }), allowed: async () => { calls.push('git'); }, submit: async () => { calls.push('submit'); }, inspect: () => null, canAdmit: () => true });
  cleanup(t, async () => { await runtime.close(); await rm(project, { recursive: true, force: true }); });
  await runtime.intake.init();
  const before = runtime.intake.view(), saved = await readFile(join(state, 'shared-intake.json'), 'utf8');
  const config = { enabled: true, repositoryId: 'local-project', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 60000 };
  await assert.rejects(runtime.intake.configure(config, before.revision), error => error.code === 'invalid_input' && /shorter worker state directory/.test(error.message));
  assert.deepEqual(runtime.intake.view().config, before.config); assert.equal(runtime.intake.view().revision, before.revision);
  assert.equal(await readFile(join(state, 'shared-intake.json'), 'utf8'), saved);
  assert.deepEqual(await readdir(state), ['shared-intake.json']); assert.deepEqual(calls, []);
});

test('a partial shared intake configuration names the fields it is missing', async () => {
  const { validateSharedIntakeConfig } = await import('../../src/worker/dist/worker/application/shared-feature-state.js');
  assert.throws(() => validateSharedIntakeConfig({ enabled: true }), /incomplete; missing repositoryId, remote, branch, workflowPath, pollMs\. Send the complete config from shared status/);
  assert.throws(() => validateSharedIntakeConfig({ enabled: true, repositoryId: 'local-project', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json' }), /missing pollMs\./);
  assert.throws(() => validateSharedIntakeConfig({ enabled: true, repositoryId: 'local-project', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 60000, extra: 1 }), /accepts only enabled, repositoryId, remote, branch, workflowPath, pollMs/);
  assert.throws(() => validateSharedIntakeConfig({ enabled: 'yes', repositoryId: '', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 60000 }), /enabled must be true or false/);
  assert.throws(() => validateSharedIntakeConfig({ enabled: true, repositoryId: '', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 60000 }), /Choose an assigned repository/);
  const config = { enabled: true, repositoryId: 'local-project', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 60000 };
  assert.deepEqual(validateSharedIntakeConfig(config), config);
});
