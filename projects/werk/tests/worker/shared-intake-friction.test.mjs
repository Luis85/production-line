import { cleanup } from './fixture-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { commands } from '../../scripts/runtime/portable/commands.mjs';
import { workerBody } from '../../scripts/runtime/portable/worker-commands.mjs';
import { FeatureRequests } from '../../src/worker/dist/worker/application/feature-requests.js';
import { MarkdownFeatureFolder } from '../../src/worker/dist/worker/infrastructure/features/folder.js';
import { assertPublicationPath } from '../../src/worker/dist/worker/infrastructure/features/git-io.js';

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

async function folderFixture(t) {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'werk-shared-guard-'))), directory = join(project, 'requests'), state = join(project, '.state');
  await mkdir(state); await mkdir(directory);
  const submissions = [];
  const queue = { async submit(record) { submissions.push(structuredClone(record)); }, inspect() { return { status: 'queued' }; } };
  const service = new FeatureRequests(new MarkdownFeatureFolder(directory, state, 'claude-cli', project), queue, 0); await service.init();
  cleanup(t, async () => { await service.close(); await rm(project, { recursive: true, force: true }); });
  return { directory, service, submissions };
}
const shared = '---\nschemaVersion: 1\ntemplateId: feature-request-v1\nid: fr-5c8c2981-7c51-4fe2-9eb3-3475020bc0d4\ntitle: Shared request\nstatus: ready\nmode: patch\npaths:\n  - docs/a.md\n---\n# Goal\n\nChange a.\n';

test('local folder intake leaves shared Git requests untouched and says how to process them', async t => {
  const f = await folderFixture(t), path = join(f.directory, 'shared.md');
  await writeFile(path, shared);
  for (let i = 0; i < 3; i++) await f.service.tick(true);
  assert.equal(f.submissions.length, 0);
  assert.equal(await readFile(path, 'utf8'), shared, 'no lifecycle metadata was written into the team file');
  assert.match(JSON.stringify(f.service.view().errors), /Shared Git request: connect shared intake/);
  // An ordinary local request in the same folder is still admitted.
  await writeFile(join(f.directory, 'local.md'), '---\nschemaVersion: 1\ntitle: Local request\nstatus: ready\n---\n# Goal\n\nExplain.\n');
  await f.service.tick(true); await f.service.tick(true);
  assert.equal(f.submissions.length, 1); assert.equal(f.submissions[0].name, 'local.md');
});

test('shared drafts are skipped quietly; only ready shared requests are reported', async t => {
  const f = await folderFixture(t);
  await writeFile(join(f.directory, 'draft.md'), shared.replace('status: ready', 'status: draft'));
  await f.service.tick(true); await f.service.tick(true);
  assert.equal(f.submissions.length, 0); assert.deepEqual(f.service.view().errors, []);
});

test('Windows publication paths are checked up front with an actionable message', () => {
  const repository = 'C:\\Projects\\PMO.Trumpf.LACForce';
  const key = 'a'.repeat(64);
  assert.doesNotThrow(() => assertPublicationPath(join(repository, '.werk', 'worker', 'shared-git', key), repository, 'win32'));
  const deep = join('C:\\Users\\someone\\AppData\\Local\\Temp\\claude\\' + 'x'.repeat(120), 'project', '.werk', 'worker', 'shared-git', key);
  assert.throws(() => assertPublicationPath(deep, 'D:\\elsewhere', 'win32'), error => error.code === 'invalid_input' && /shorter worker state directory.*needs \d+ of at most 220 bytes.*--state-dir/.test(error.message));
  assert.doesNotThrow(() => assertPublicationPath(deep, 'D:\\elsewhere', 'linux'));
});
