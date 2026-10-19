import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { FeatureRequests } from '../../src/worker/dist/worker/application/feature-requests.js';
import { MarkdownFeatureFolder } from '../../src/worker/dist/worker/infrastructure/features/folder.js';
import { cli as installed, exec, exists, git, temporary } from './project-worker-uninstall-fixture.mjs';

const installer = resolve('bin/apps/worker/cli.mjs');
const run = (cwd, entry, ...args) => exec(process.execPath, [entry, ...args], { cwd, timeout: 120000, maxBuffer: 8 * 1048576 }).then(result => JSON.parse(result.stdout));
const init = (cwd, ...args) => run(cwd, installer, 'init', '--no-npm', ...args);
const failure = error => String(error.stderr) + String(error.stdout);
const front = raw => parse(/^---\n([\s\S]*?)\n---\n/.exec(raw)[1]);
const read = path => readFile(path, 'utf8');

test('init --intake local writes a local request template, records the choice and reports local commands', async t => {
  const cwd = await temporary(t, 'werk-local-init-'), result = await init(cwd, '--intake', 'local', '--features-dir', 'requests', '--provider', 'claude-cli');
  const template = join(cwd, 'requests/_templates/local-request.md'), raw = await read(template), data = front(raw);
  assert.equal(data.templateId, undefined); assert.equal(data.status, 'draft'); assert.equal(data.mode, 'patch'); assert.equal(data.provider, 'claude-cli'); assert.equal(data.schemaVersion, 1);
  assert.equal(data.paths, undefined); assert.doesNotMatch(raw.split(/^---$/m)[2], /Ready to queue|feature create|templateId/, 'Operator instructions stay out of the body sent to the model.'); assert.deepEqual(raw.split(/^---$/m)[2].match(/^#{1,2} .*$/gm), ['# Goal', '## Acceptance criteria', '## Context']); assert.match(raw.split(/^---$/m)[1], /OUTSIDE the feature folder/); assert.match(raw, /^# paths:\n#   - src\/example\.ts\n#   - docs\/$/m); assert.match(raw, /^# definitionRef: /m);
  assert.deepEqual(JSON.parse(await read(join(cwd, '.werk/worker.json'))).features, { directory: 'requests', provider: 'claude-cli', pollMs: 1000, intake: 'local' });
  assert.equal(result.intake.mode, 'local'); assert.equal(result.intake.connectionRequired, false); assert.equal(result.intake.template, template);
  assert.match(result.intake.commands.create, /feature create --name \S+ --markdown \S+/); assert.match(result.intake.commands.validate, /feature validate --name/); assert.match(result.intake.commands.submit, /feature submit --name \S+ --if-match/);
  assert.match(result.intake.next, /requests\/_templates\/local-request\.md/); assert.match(result.intake.next, /repository accept --discovery-id/); assert.equal(result.next, result.intake.next);
  assert.doesNotMatch(JSON.stringify(result.intake), /shared setup|shared configure/);
  const shared = front(await read(join(cwd, 'requests/_templates/feature-request.md')));
  assert.equal(shared.templateId, 'feature-request-v1', 'The offline authoring kit is installed unchanged.');
  assert.equal(await exists(join(cwd, '.werk/authoring/feature-request.mjs')), true);
});

test('repeat init keeps the recorded choice and user edits; a conflicting --intake names the file to edit', async t => {
  const cwd = await temporary(t, 'werk-local-repeat-'); await init(cwd, '--intake', 'local');
  const entry = join(cwd, 'bin/apps/worker/cli.mjs'), template = join(cwd, 'features/_templates/local-request.md'); await writeFile(template, '# My template\n');
  const again = await run(cwd, entry, 'init', '--no-npm');
  assert.equal(again.intake.mode, 'local'); assert.equal(await read(template), '# My template\n');
  await assert.rejects(run(cwd, entry, 'init', '--no-npm', '--intake', 'shared'), error => /--intake shared differs from features\.intake \W*local\W* in \.werk\/worker\.json/.test(failure(error)));
  await assert.rejects(init(await temporary(t, 'werk-local-bad-'), '--intake', 'both'), error => /--intake must be shared or local/.test(failure(error)));
});

test('default init stays shared: no local template, no intake key and the shared connection guidance', async t => {
  const cwd = await temporary(t, 'werk-shared-default-'), result = await init(cwd);
  assert.equal(result.intake.mode, 'shared_git'); assert.equal(result.intake.connectionRequired, true); assert.match(result.next, /provider configure|shared setup/);
  assert.equal(await exists(join(cwd, 'features/_templates/local-request.md')), false);
  assert.equal(JSON.parse(await read(join(cwd, '.werk/worker.json'))).features.intake, undefined);
  assert.equal((await init(await temporary(t, 'werk-shared-explicit-'), '--intake', 'shared')).intake.mode, 'shared_git');
});

test('a request created from the local template is accepted by local folder intake, unlike the shared template', async t => {
  const cwd = await temporary(t, 'werk-local-folder-'); await init(cwd, '--intake', 'local');
  const features = join(cwd, 'features'), state = join(cwd, '.state'); await mkdir(state); await mkdir(join(cwd, 'src')); await writeFile(join(cwd, 'src/example.ts'), 'export {};\n');
  const template = await read(join(features, '_templates/local-request.md'));
  const draft = template.replace('# paths:', 'paths:').replace('#   - src/example.ts', '  - src/example.ts').replace('#   - docs/', '  - docs/');
  const submitted = [], queue = { async submit(record) { submitted.push(record); }, inspect: () => ({ status: 'queued' }), async control() {} };
  const service = new FeatureRequests(new MarkdownFeatureFolder(features, state, 'claude-cli', cwd), queue, 0); await service.init();
  try {
  const action = (name, extra = {}) => service.action({ action: name, name: 'request.md', ...extra });
  let file = await action('create', { markdown: draft }); assert.equal((await action('validate')).valid, true);
  file = await action('submit', { revision: file.revision }); await service.tick(true); await service.tick(true);
  assert.equal(submitted.length, 1); assert.equal((await service.list()).files.find(item => item.name === 'request.md').shared, false);
  assert.deepEqual(front(await read(join(features, 'request.md'))).paths, ['src/example.ts', 'docs/']);
  await writeFile(join(features, 'team.md'), (await read(join(features, '_templates/feature-request.md'))).replace('status: draft', 'status: ready')); await service.tick(true);
  assert.equal((await service.list()).files.find(item => item.name === 'team.md').shared, true, 'The shared template carries templateId and is skipped by folder intake.');
  assert.equal(submitted.length, 1);
  await assert.rejects(service.action({ action: 'create', name: 'bare.md', markdown: template }), /explicit paths list. Set paths: list the approved files or folders.*uncomment the paths example/);
  await writeFile(join(features, 'copy.md'), template); await service.tick(true);
  assert.match((await service.list()).files.find(item => item.name === 'copy.md').error, /explicit paths list/, 'An unedited copy inside the folder is an error, the reason to keep copies outside it.');
  } finally { await service.close(); }
});

test('footprint and uninstall treat the local template as a generated authoring file', async t => {
  const cwd = await temporary(t, 'werk-local-footprint-'); await git(cwd, 'init', '-q'); await init(cwd, '--intake', 'local');
  const path = 'features/_templates/local-request.md', find = value => value.groups.authoring.find(entry => entry.path === path);
  assert.equal(find(await installed(cwd, 'footprint')).managed, true);
  assert.ok((await installed(cwd, 'uninstall', '--dry-run')).remove.some(item => item.path === path));
  await writeFile(join(cwd, path), '# Edited by the operator\n');
  const edited = find(await installed(cwd, 'footprint')); assert.equal(edited.managed, false); assert.match(edited.note, /kept as your work/);
  assert.ok((await installed(cwd, 'uninstall', '--dry-run')).keep.some(item => item.path === path));
});
