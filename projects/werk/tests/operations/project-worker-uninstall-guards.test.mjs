import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cli, exists, git, project, temporary } from './project-worker-uninstall-fixture.mjs';
import { status, stateAbsent } from '../../scripts/runtime/portable/lifecycle.mjs';
import { removeUntracked } from '../../scripts/runtime/portable/footprint-files.mjs';

const edited = '\n<!-- Team note: keep this edit. -->\n';

test('edited templates inside an included request folder stay in the dry run and the removal', { timeout: 240000 }, async t => {
  const cwd = await project(t), template = 'features/_templates/feature-request.md';
  await appendFile(join(cwd, template), edited);
  const preview = await cli(cwd, 'uninstall', '--dry-run', '--include-requests');
  assert.match(preview.keep.find(item => item.path === template)?.reason ?? '', /Changed from the generated content/);
  assert.equal(preview.remove.find(item => item.path === 'features')?.partial, true, 'The request folder cannot go completely while the template stays.');
  const result = await cli(cwd, 'uninstall', '--confirm', '--include-requests');
  assert.match(await readFile(join(cwd, template), 'utf8'), /Team note: keep this edit/);
  assert.equal(await exists(join(cwd, 'features/team-request.md')), false, 'Other untracked request files are removed as requested.');
  assert.match(result.kept.find(item => item.path === template).reason, /Changed from the generated content/);
});

test('an edited local request template stays when request folders are included', { timeout: 240000 }, async t => {
  const cwd = await project(t), template = 'features/_templates/local-request.md';
  const config = JSON.parse(await readFile(join(cwd, '.werk/worker.json'), 'utf8'));
  await writeFile(join(cwd, '.werk/worker.json'), JSON.stringify({ ...config, features: { ...config.features, intake: 'local' } }), { mode: 0o600 });
  await writeFile(join(cwd, template), '---\ntitle: Local\nstatus: draft\nmode: patch\n---\nOur own local template.\n');
  const preview = await cli(cwd, 'uninstall', '--dry-run', '--include-requests');
  assert.match(preview.keep.find(item => item.path === template)?.reason ?? '', /Changed from the generated content/);
  await cli(cwd, 'uninstall', '--confirm', '--include-requests');
  assert.match(await readFile(join(cwd, template), 'utf8'), /Our own local template/);
});

test('a folder entry named .git in any letter case is never entered or removed', { timeout: 240000 }, async t => {
  const cwd = await project(t), odd = join(cwd, 'features/odd/.Git');
  await mkdir(odd, { recursive: true }); await writeFile(join(odd, 'HEAD'), 'ref: refs/heads/main\n');
  const preview = await cli(cwd, 'uninstall', '--dry-run', '--include-requests');
  assert.deepEqual(preview.keep.find(item => item.repositories)?.repositories, ['features/odd']);
  await cli(cwd, 'uninstall', '--confirm', '--include-requests');
  assert.equal(await readFile(join(odd, 'HEAD'), 'utf8'), 'ref: refs/heads/main\n');
});

test('a --state-dir that names a file is kept by the dry run and footprint, and --confirm refuses', { timeout: 240000 }, async t => {
  const cwd = await project(t);
  await writeFile(join(cwd, 'notes.txt'), 'not worker state\n');
  const preview = await cli(cwd, 'uninstall', '--dry-run', '--state-dir', 'notes.txt');
  assert.match(preview.keep.find(item => item.path === 'notes.txt')?.reason ?? '', /state directory is a file, not a folder.*--state-dir/);
  assert.equal(preview.remove.some(item => item.path === 'notes.txt'), false);
  assert.equal(preview.worker.state, 'stopped', 'A file state path holds no running worker (ENOTDIR on POSIX counts as absent).');
  assert.equal((await cli(cwd, 'footprint', '--state-dir', 'notes.txt')).groups.state.find(item => item.path === 'notes.txt').type, 'file');
  const refused = await cli(cwd, 'uninstall', '--confirm', '--state-dir', 'notes.txt').then(() => '', error => String(error.stderr) + String(error.stdout));
  assert.match(refused, /notes\.txt is not a folder.*--state-dir or WERK_WORKER_STATE_DIR/);
  assert.equal(await readFile(join(cwd, 'notes.txt'), 'utf8'), 'not worker state\n');
  assert.equal(await exists(join(cwd, '.werk/worker-project.json')), true, 'Nothing is removed when --confirm refuses.');
});

test('a state file path counts as absent, never as a status error', async t => {
  const directory = await temporary(t, 'werk-state-file-'), file = join(directory, 'state.txt');
  await writeFile(file, 'x');
  for (const code of ['ENOENT', 'ENOTDIR']) assert.equal(stateAbsent({ code }), true, code);
  assert.equal(stateAbsent({ code: 'EACCES' }), false);
  assert.equal((await status('worker', file)).state, 'stopped');
});

test('kept paths are compared without case when the tracked set is caseless', async t => {
  const directory = await temporary(t, 'werk-skip-case-');
  await mkdir(join(directory, 'Requests/_templates'), { recursive: true }); await writeFile(join(directory, 'Requests/_templates/Local.md'), 'kept\n');
  const caseless = { key: path => path.toLowerCase(), files: new Set() };
  const result = await removeUntracked(directory, join(directory, 'Requests'), caseless, { skip: [join(directory, 'requests/_templates/local.md')] });
  assert.equal(result.gone, false);
  assert.equal(await readFile(join(directory, 'Requests/_templates/Local.md'), 'utf8'), 'kept\n');
});
test('a tracked .werk/.gitignore does not keep the project marker', { timeout: 240000 }, async t => {
  const cwd = await project(t);
  await git(cwd, 'add', '-f', '.werk/.gitignore'); await git(cwd, 'commit', '-q', '-m', 'ignore rules');
  const preview = await cli(cwd, 'uninstall', '--dry-run');
  assert.ok(preview.remove.some(item => item.path === '.werk/worker-project.json'), 'The dry run removes the marker.');
  const result = await cli(cwd, 'uninstall', '--confirm');
  assert.equal(await exists(join(cwd, '.werk/worker-project.json')), false);
  assert.equal(await exists(join(cwd, '.werk/.gitignore')), true);
  assert.match(result.kept.find(item => item.path === '.werk/.gitignore').reason, /Tracked by Git/);
});

test('a guard kept for tracked worker state says to remove the tracked file in a commit', { timeout: 240000 }, async t => {
  const cwd = await project(t);
  await writeFile(join(cwd, '.werk/worker/webview-token'), 'e'.repeat(64));
  await git(cwd, 'add', '-f', '.werk/worker/webview-token'); await git(cwd, 'commit', '-q', '-m', 'mistaken state');
  const preview = await cli(cwd, 'uninstall', '--dry-run');
  const result = await cli(cwd, 'uninstall', '--confirm');
  for (const reason of [preview.keep, result.kept].map(list => list.find(item => item.path === '.werk/worker-project.json')?.reason ?? ''))
    assert.match(reason, /Kept while \.werk\/worker still exists.*tracked by Git.*in a commit/);
  assert.equal(await exists(join(cwd, '.werk/worker/webview-token')), true);
});
