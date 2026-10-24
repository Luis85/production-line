import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  assert.equal(data.templateId, undefined); assert.equal(data.intent, 'draft'); assert.equal(data.mode, 'patch'); assert.equal(data.provider, 'claude-cli'); assert.equal(data.schema, 'worker.request/v1');
  assert.deepEqual(data.paths, ['src/']); assert.match(raw, /id: FR-0001/); assert.match(raw, /## Answers/); assert.match(raw, /<!-- worker:begin -->/); assert.match(raw, /unique request ID/);
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

test('an existing shared installation refuses init --intake local without changing its configuration', async t => {
  const cwd = await temporary(t, 'werk-shared-preserved-'); await init(cwd);
  const config = join(cwd, '.werk/worker.json'), before = await read(config);
  await assert.rejects(run(cwd, join(cwd, 'bin/apps/worker/cli.mjs'), 'init', '--intake', 'local'), error => {
    assert.match(failure(error), /--intake local differs from features\.intake \W*shared\W* in \.werk\/worker\.json/);
    assert.match(failure(error), /stop the worker.*installed app.*finish owned shared requests and clear the shared repository binding/s);
    return true;
  });
  assert.equal(await read(config), before);
  assert.equal(await exists(join(cwd, 'features/_templates/local-request.md')), false);
});

test('a request created from the local template is accepted by local folder intake, unlike the shared template', async t => {
  const cwd = await temporary(t, 'werk-local-folder-'); await init(cwd, '--intake', 'local');
  const features = join(cwd, 'features'), state = join(cwd, '.state'); await mkdir(state); await mkdir(join(cwd, 'src')); await writeFile(join(cwd, 'src/example.ts'), 'export {};\n');
  const template = await read(join(features, '_templates/local-request.md'));
  const draft = template.replace('paths: [src/]', 'paths: [src/example.ts, docs/]');
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
  await service.action({ action: 'create', name: 'bare.md', markdown: template.replace('FR-0001', 'FR-0002').replace('paths: [src/]\n', '') });
  const bare = await service.action({ action: 'get', name: 'bare.md' });
  await assert.rejects(service.action({ action: 'submit', name: 'bare.md', revision: bare.revision }), /approved paths/);
  await writeFile(join(features, 'copy.md'), template); await service.tick(true);
  assert.ok(service.view().errors.some(error => /Duplicate feature ID/.test(error.message)), 'Copies retain identity and duplicates block execution.');
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

test('the help schema lists init --intake shared|local with the same choices init validates', async t => {
  const cwd = await temporary(t, 'werk-local-help-'), setup = (await run(cwd, installer, 'help')).projectSetup;
  assert.match(setup.command, /^init .*\[--intake shared\|local\]/);
  assert.match(setup.intake, /--intake shared \(default\).*--intake local writes <features-dir>\/_templates\/local-request\.md/);
  await assert.rejects(init(cwd, '--intake', 'both'), error => /--intake/.test(failure(error)));
});

const excludeLines = async cwd => (await read(join(cwd, '.git/info/exclude')).catch(() => '')).split(/\r?\n/);

test('local init in a git checkout excludes the default review folder once and reports it', async t => {
  const cwd = await temporary(t, 'werk-local-exclude-'); await git(cwd, 'init', '-q');
  const first = await init(cwd, '--intake', 'local'); assert.deepEqual(first.intake.excluded, ['/feature-reviews/']); assert.deepEqual(first.intake.warnings, []); assert.match(first.intake.next, /\/feature-reviews\/.*\.git\/info\/exclude/);
  const again = await run(cwd, join(cwd, 'bin/apps/worker/cli.mjs'), 'init', '--no-npm'); assert.deepEqual(again.intake.excluded, ['/feature-reviews/']);
  assert.equal((await excludeLines(cwd)).filter(line => line === '/feature-reviews/').length, 1);
});

test('local init keeps existing exclude entries and adds the line after a missing trailing newline', async t => {
  const cwd = await temporary(t, 'werk-local-exclude-keep-'); await git(cwd, 'init', '-q'); await writeFile(join(cwd, '.git/info/exclude'), '# mine\n/scratch/');
  await init(cwd, '--intake', 'local'); assert.equal(await read(join(cwd, '.git/info/exclude')), '# mine\n/scratch/\n/feature-reviews/\n');
});

test('local init in a linked worktree writes the shared exclude file of the main repository', async t => {
  const main = await temporary(t, 'werk-local-exclude-main-'), linked = join(await temporary(t, 'werk-local-exclude-link-'), 'wt');
  await git(main, 'init', '-q'); await writeFile(join(main, 'README.md'), '# x\n'); await git(main, 'add', 'README.md'); await git(main, 'commit', '-q', '-m', 'init'); await git(main, 'worktree', 'add', '-q', linked);
  const result = await init(linked, '--intake', 'local'); assert.deepEqual(result.intake.excluded, ['/feature-reviews/']);
  assert.ok((await excludeLines(main)).includes('/feature-reviews/'));
});

test('local init leaves a review folder with tracked files alone and says so', async t => {
  const cwd = await temporary(t, 'werk-local-exclude-tracked-'); await git(cwd, 'init', '-q'); await mkdir(join(cwd, 'feature-reviews')); await writeFile(join(cwd, 'feature-reviews/note.md'), '# kept\n'); await git(cwd, 'add', 'feature-reviews/note.md');
  const result = await init(cwd, '--intake', 'local'); assert.deepEqual(result.intake.excluded, []); assert.match(result.intake.warnings.join('\n'), /feature-reviews.*tracked/);
  assert.equal((await excludeLines(cwd)).includes('/feature-reviews/'), false);
});

test('local init in a project below the repository root does not touch the repository exclude file', async t => {
  const root = await temporary(t, 'werk-local-exclude-sub-'), cwd = join(root, 'app'); await git(root, 'init', '-q'); await mkdir(cwd);
  const result = await init(cwd, '--intake', 'local'); assert.deepEqual(result.intake.excluded, []); assert.equal((await excludeLines(root)).includes('/feature-reviews/'), false);
});

test('local init refuses an exclude path that is not a regular file', async t => {
  const cwd = await temporary(t, 'werk-local-exclude-dir-'); await git(cwd, 'init', '-q'); await rm(join(cwd, '.git/info/exclude'), { force: true }); await mkdir(join(cwd, '.git/info/exclude'), { recursive: true });
  await assert.rejects(init(cwd, '--intake', 'local'), error => /regular file/.test(failure(error)));
});

test('shared init in a git checkout and local init outside git leave exclusion alone', async t => {
  const repo = await temporary(t, 'werk-shared-exclude-'); await git(repo, 'init', '-q'); const shared = await init(repo);
  assert.equal(shared.intake.excluded, undefined); assert.equal((await excludeLines(repo)).includes('/feature-reviews/'), false);
  const plain = await temporary(t, 'werk-local-nogit-'), result = await init(plain, '--intake', 'local');
  assert.deepEqual(result.intake.excluded, []); assert.deepEqual(result.intake.warnings, []); assert.equal(await exists(join(plain, '.git')), false);
});
