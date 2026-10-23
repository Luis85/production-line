import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedFeatureAuthoring } from '../../src/worker/dist/worker/application/feature-authoring.js';
import { defaultFeatureWorkflow, defaultFeatureCheck, featureContentHash } from '../../src/worker/dist/worker/application/feature-workflow.js';
import { featureAuthoringDocuments } from '../../src/worker/dist/worker/infrastructure/features/authoring-document.js';
import { loadFeatureWorkflowSnapshot } from '../../src/worker/dist/worker/infrastructure/features/workflow.js';
import { GitFeatureRepository } from '../../src/worker/dist/worker/infrastructure/features/git-repository.js';
import { featureGitIo } from './runtime-fixtures.mjs';

prepareNativeProcessFixture();

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'user.name=Werk Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const template = `---
schemaVersion: 1
templateId: team-v1
title: Describe the feature
status: draft
mode: patch
paths: []
component: ""
---
# Goal
<!-- Describe the desired result. -->
## Context
<!-- Add the constraints. -->
## Acceptance criteria
- [ ] <!-- Observable behavior. -->
## Verification plan
<!-- Explain verification. -->
## Accessibility
<!-- Explain keyboard behavior. -->
`;
const seed = { title: 'Export orders', message: 'Add a CSV export.', provider: 'codex-cli', paths: ['orders.ts'] };
const complete = markdown => markdown.replace('component: ""', 'component: orders')
  .replace('<!-- Add the constraints. -->', 'Preserve the existing order list.')
  .replace('<!-- Observable behavior. -->', 'Exported CSV contains every selected order.')
  .replace('<!-- Explain verification. -->', 'Run the CSV export tests.')
  .replace('<!-- Explain keyboard behavior. -->', 'The export button is keyboard accessible.');
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-fr-authoring-')));
  const remote = join(directory, 'remote.git'), producer = join(directory, 'producer'), repository = join(directory, 'worker');
  git(directory, 'init', '--bare', '--initial-branch=main', remote); git(directory, 'clone', '--', remote, producer);
  const configuration = defaultFeatureWorkflow();
  const workflowFiles = { '.werk/feature-workflow.json': JSON.stringify(configuration), [configuration.template]: template, [configuration.base]: 'views: []\n', [configuration.readyCheck]: JSON.stringify(defaultFeatureCheck('ready')), [configuration.doneCheck]: JSON.stringify(defaultFeatureCheck('done')) };
  for (const [path, content] of Object.entries({ ...workflowFiles, 'orders.ts': 'export const orders = [];\n' })) { await mkdir(join(producer, ...path.split('/').slice(0, -1)), { recursive: true }); await writeFile(join(producer, path), content); }
  git(producer, 'add', '.'); git(producer, 'commit', '-m', 'Team setup'); git(producer, 'push', 'origin', 'main'); git(directory, 'clone', '--', remote, repository);
  const options = { repository, remote: 'origin', branch: 'main', requestsDirectory: configuration.requestsDirectory, reviewDirectory: configuration.reviewDirectory, tasksDirectory: configuration.tasksDirectory, stateDirectory: join(directory, 'state'), workerId: 'worker-one' };
  const clients = [];
  const client = () => { const value = new GitFeatureRepository(options); clients.push(value); return value; };
  let adapter = client(), syncs = 0;
  const controls = { binding: { repositoryId: 'project', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json' }, syncFails: false };
  const ports = {
    binding: () => controls.binding,
    repository: () => ({ head: signal => adapter.head(signal), readBlob: (commit, path, signal) => adapter.readBlob(commit, path, signal), listRequests: (commit, signal) => adapter.list(commit, undefined, signal), publishRequest: (input, signal) => adapter.publishRequest(input, signal) }),
    loadWorkflow: (reader, commit, configPath, signal) => loadFeatureWorkflowSnapshot({ commit, configPath, readBlob: (sha, path) => reader.readBlob(sha, path, signal) }),
    documents: featureAuthoringDocuments,
    sync: async () => { syncs++; if (controls.syncFails) throw Error('Paused intake'); },
  };
  let authoring = new SharedFeatureAuthoring(ports);
  const prepare = (overrides = {}) => authoring.command({ action: 'prepare', operationId: 'draft-one', seed, ...overrides });
  const input = (draft, overrides = {}) => ({ action: 'publish', operationId: 'publish-one', name: draft.name, markdown: draft.markdown, expectedRevision: draft.revision, expectedWorkflowDigest: draft.workflowDigest, expectedBinding: draft.binding, ...overrides });
  const publish = (draft, overrides = {}) => authoring.command(input(draft, overrides));
  async function teammate(path, content) {
    git(producer, 'pull', '--ff-only', 'origin', 'main'); await mkdir(join(producer, ...path.split('/').slice(0, -1)), { recursive: true }); await writeFile(join(producer, path), content); git(producer, 'add', '--', path); git(producer, 'commit', '-m', 'Team edit'); git(producer, 'push', 'origin', 'main');
  }
  t.after(async () => { for (const value of clients) await value.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, remote, repository, configuration, controls, workflowFiles, prepare, publish, input, teammate, get adapter() { return adapter; }, get authoring() { return authoring; }, get syncs() { return syncs; }, async restart() { await adapter.close(); adapter = client(); authoring = new SharedFeatureAuthoring(ports); } };
}

test('chat seeds a stable template draft, preserves custom requirements, and does not publish or dispatch', async t => {
  const f = await fixture(t), head = git(f.remote, 'rev-parse', 'main');
  const draft = await f.prepare(), repeated = await f.prepare();
  assert.equal(draft.featureId, repeated.featureId); assert.equal(draft.name, repeated.name); assert.equal(draft.revision, null);
  assert.equal(draft.status, 'draft'); assert.equal(draft.readiness.valid, false);
  assert.match(draft.markdown, /# Goal\n\nAdd a CSV export/); assert.match(draft.markdown, /component: ""/); assert.match(draft.markdown, /## Accessibility/);
  assert.equal(git(f.remote, 'rev-parse', 'main'), head); assert.equal(f.syncs, 0);
});

test('draft publication preserves developer checkout and reopens the same canonical request after restart', async t => {
  const f = await fixture(t), draft = await f.prepare();
  await writeFile(join(f.repository, 'orders.ts'), 'developer staged\n'); git(f.repository, 'add', 'orders.ts');
  await writeFile(join(f.repository, 'orders.ts'), 'developer working edit\n');
  const index = git(f.repository, 'write-tree'), head = git(f.repository, 'rev-parse', 'HEAD');
  const saved = await f.publish(draft, { status: 'draft' });
  assert.equal(saved.status, 'draft'); assert.equal(saved.readiness.valid, false); assert.ok(saved.publication);
  assert.equal(git(f.remote, 'show', `main:${saved.path}`), saved.markdown.trim()); assert.equal(f.syncs, 1);
  assert.equal(git(f.repository, 'rev-parse', 'HEAD'), head); assert.equal(git(f.repository, 'write-tree'), index); assert.equal(await readFile(join(f.repository, 'orders.ts'), 'utf8'), 'developer working edit\n');
  await f.restart();
  const reopened = await f.authoring.command({ action: 'prepare', operationId: 'reopen-one', name: draft.name });
  assert.equal(reopened.featureId, draft.featureId); assert.equal(reopened.revision, saved.revision); assert.equal(reopened.markdown, saved.markdown);
});

test('explicit ready publication uses the identical template and rules as Markdown intake', async t => {
  const f = await fixture(t), draft = await f.prepare();
  await assert.rejects(f.publish(draft, { status: 'ready' }), /not ready/); assert.equal(f.syncs, 0);
  const ready = await f.publish(draft, { markdown: complete(draft.markdown), status: 'ready' });
  assert.equal(ready.status, 'ready'); assert.equal(ready.readiness.valid, true); assert.equal(ready.featureId, draft.featureId); assert.equal(f.syncs, 1);
  await assert.rejects(f.publish(ready, { operationId: 'rewrite-ready', markdown: ready.markdown.replace('CSV export.', 'Different scope.') }), /Only the same unclaimed draft/);
});

test('Save draft keeps even hand-edited ready Markdown nonexecutable', async t => {
  const f = await fixture(t), draft = await f.prepare();
  const saved = await f.publish(draft, { status: 'draft', markdown: complete(draft.markdown).replace('status: draft', 'status: ready') });
  assert.equal(saved.status, 'draft'); assert.match(git(f.remote, 'show', `main:${saved.path}`), /status: draft/);
});

test('edited previews and publication reject stale source, workflow and binding', async t => {
  const f = await fixture(t), draft = await f.prepare(), saved = await f.publish(draft);
  const edited = saved.markdown.replace('CSV export.', 'CSV export with filters.'); await f.teammate(saved.path, edited);
  await assert.rejects(f.authoring.command({ action: 'prepare', operationId: 'preview-edits', name: saved.name, markdown: complete(saved.markdown), expectedRevision: saved.revision }), /changed remotely/);
  await assert.rejects(f.publish(saved, { operationId: 'stale-write' }), /changed before publication/);
  f.controls.binding = { ...f.controls.binding, repositoryId: 'different-project' };
  await assert.rejects(f.publish(saved, { operationId: 'wrong-target' }), /binding changed/);
  f.controls.binding = { ...f.controls.binding, repositoryId: 'project' };
  await f.teammate(f.configuration.readyCheck, JSON.stringify({ ...defaultFeatureCheck('ready'), version: 2 }));
  await assert.rejects(f.publish(saved, { operationId: 'stale-workflow' }), /template or checks changed|changed before publication/);
  assert.equal(git(f.remote, 'show', `main:${saved.path}`), edited.trim()); assert.equal(f.syncs, 1);
});

test('one identity cannot create two intake notes and draft revisions cannot replace identity', async t => {
  const f = await fixture(t), saved = await f.publish(await f.prepare());
  await assert.rejects(f.publish(saved, { operationId: 'duplicate-id', name: 'another.md', expectedRevision: null }), /feature ID already belongs/);
  await assert.rejects(f.publish(saved, { operationId: 'replacement-id', markdown: saved.markdown.replace(saved.featureId, 'different-feature') }), /same unclaimed draft/);
  await assert.rejects(f.publish(saved, { operationId: 'case-alias', name: saved.name.toUpperCase().replace('.MD', '.md'), expectedRevision: null, markdown: saved.markdown.replace(saved.featureId, 'different-feature') }), /case or Unicode/);
  assert.equal(f.syncs, 1);
});

test('a lost publication acknowledgment and restart replay one operation without replacing later lifecycle', async t => {
  const f = await fixture(t), draft = await f.prepare(), input = f.input(draft, { status: 'ready', markdown: complete(draft.markdown) });
  const io = featureGitIo(f.adapter), push = io.push.bind(io);
  io.push = async (...args) => { await push(...args); throw Error('Lost acknowledgement'); };
  const published = await f.authoring.command(input);
  const owned = published.markdown.replace('status: ready', 'status: running\nwerk:\n  owner: worker-one');
  await f.adapter.publishLifecycle({ operationId: 'worker-claim', request: { path: published.path, expectedRevision: published.revision, content: owned } });
  const head = git(f.remote, 'rev-parse', 'main'); await f.restart();
  const replay = await f.authoring.command(input);
  assert.equal(replay.publication.replayed, true); assert.equal(replay.publication.commit, published.publication.commit); assert.equal(git(f.remote, 'rev-parse', 'main'), head);
  assert.match(git(f.remote, 'show', `main:${published.path}`), /status: running/);
  await assert.rejects(f.authoring.command({ ...input, markdown: input.markdown.replace('CSV export.', 'New task.') }), /operation ID already belongs/);
});

test('failed push never triggers intake and the exact operation can later succeed', async t => {
  const f = await fixture(t), draft = await f.prepare(), head = git(f.remote, 'rev-parse', 'main');
  const io = featureGitIo(f.adapter), push = io.push.bind(io); io.push = async () => { throw Error('Remote unavailable'); };
  await assert.rejects(f.publish(draft), /pending/); assert.equal(f.syncs, 0); assert.equal(git(f.remote, 'rev-parse', 'main'), head);
  io.push = push; await f.publish(draft); assert.equal(f.syncs, 1);
});

test('concurrent unrelated publication retries safely but a changed check blocks stale ready work', async t => {
  const f = await fixture(t), draft = await f.prepare(), io = featureGitIo(f.adapter), push = io.push.bind(io); let changed = false;
  io.push = async (...args) => { if (!changed) { changed = true; await f.teammate('teammate.txt', 'Other work\n'); } return push(...args); };
  const saved = await f.publish(draft); assert.equal(git(f.remote, 'show', 'main:teammate.txt'), 'Other work');
  changed = false;
  io.push = async (...args) => { if (!changed) { changed = true; await f.teammate(f.configuration.doneCheck, JSON.stringify({ ...defaultFeatureCheck('done'), version: 2 })); } return push(...args); };
  await assert.rejects(f.publish(saved, { operationId: 'ready-after-race', status: 'ready', markdown: complete(saved.markdown) }), /workflow changed/);
  assert.match(git(f.remote, 'show', `main:${saved.path}`), /status: draft/); assert.equal(f.syncs, 1);
});

test('known successful publication remains acknowledged when subsequent intake synchronization fails', async t => {
  const f = await fixture(t), draft = await f.prepare(); f.controls.syncFails = true;
  const saved = await f.publish(draft); assert.ok(saved.publication); assert.equal(saved.revision, featureContentHash(saved.markdown));
});

test('authoring rejects companion metadata, malformed commands and changed workflow before Git writes', async t => {
  const f = await fixture(t), draft = await f.prepare();
  for (const key of ['source', 'werk', 'werkOwner', 'werkTask', 'werkPullRequest', 'werkTracking']) await assert.rejects(f.publish(draft, { markdown: draft.markdown.replace('status: draft', 'status: draft\n' + key + ': injected') }), /worker-owned/);
  await assert.rejects(f.publish(draft, { expectedBinding: undefined }), /requires/);
  await assert.rejects(f.publish(draft, { name: '../outside.md' }), /filename/);
  await assert.rejects(f.authoring.command({ action: 'prepare', operationId: 'bad-seed', seed: { ...seed, provider: 'invented' } }), /supported model/);
  assert.equal(f.syncs, 0);
});

for (const change of ['ready-rule', 'template-identity']) test('exact ready publication replays after changed ' + change + ' without weakening new writes', async t => {
  const f = await fixture(t), draft = await f.prepare(), command = f.input(draft, { status: 'ready', markdown: complete(draft.markdown) });
  const published = await f.authoring.command(command);
  if (change === 'template-identity') await f.teammate(f.configuration.template, template.replace('team-v1', 'team-v2'));
  else await f.teammate(f.configuration.readyCheck, JSON.stringify({ ...defaultFeatureCheck('ready'), rules: { chat: [], patch: [{ id: 'long-title', fact: 'input.titleLength', op: 'gte', value: 100 }] } }));
  const head = git(f.remote, 'rev-parse', 'main'); await f.restart();
  const replay = await f.authoring.command(command);
  assert.equal(replay.publication.replayed, true); assert.equal(replay.publication.commit, published.publication.commit); assert.equal(replay.readiness.valid, true); assert.equal(replay.workflowDigest, published.workflowDigest); assert.equal(git(f.remote, 'rev-parse', 'main'), head);
  await assert.rejects(f.authoring.command({ ...command, operationId: 'new-stale-operation' }), /template or checks changed|changed before publication/);
  await assert.rejects(f.authoring.command({ ...command, markdown: command.markdown.replace('CSV export.', 'Different request.') }), /operation ID already belongs/);
});

test('authoring opens the same Unicode and spaced filenames accepted by Git intake', async t => {
  const f = await fixture(t), draft = await f.prepare({ name: 'CSV export – équipe.v1.md' }), saved = await f.publish(draft);
  const reopened = await f.authoring.command({ action: 'prepare', operationId: 'reopen-unicode', name: saved.name });
  assert.equal(reopened.featureId, draft.featureId); assert.equal(reopened.revision, saved.revision);
});

test('template authoring preserves fenced and commented Goal examples and updates the actual section', async t => {
  const f = await fixture(t);
  const example = '```markdown\n# Goal\nFenced example.\n```\n<!--\n# Goal\nCommented example.\n-->\n';
  await f.teammate(f.configuration.template, template.replace('# Goal', example + '# Goal'));
  const draft = await f.prepare();
  assert.match(draft.markdown, /# Goal\nFenced example/); assert.match(draft.markdown, /# Goal\nCommented example/);
  assert.match(draft.markdown, /-->\n# Goal\n\nAdd a CSV export/); assert.match(draft.markdown, /## Accessibility/);
});
