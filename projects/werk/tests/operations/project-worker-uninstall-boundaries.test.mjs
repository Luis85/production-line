import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cli, exists, git, project } from './project-worker-uninstall-fixture.mjs';
import { seedWorkerPackage, workerNpmScripts } from '../../scripts/runtime/portable/npm-package.mjs';

const options = { timeout: 180000 };

test('configured authoring files inside a nested repository stay even when addressed individually', options, async t => {
  const cwd = await project(t), nested = join(cwd, 'features');
  await git(nested, 'init', '-q');
  await git(nested, 'add', '_templates/feature-request.md');
  await git(nested, 'commit', '-q', '-m', 'nested authoring');
  const template = join(nested, '_templates/feature-request.md'), original = await readFile(template, 'utf8');
  const preview = await cli(cwd, 'uninstall', '--dry-run', '--include-requests');
  assert.ok(preview.keep.some(item => item.repositories?.includes('features')), 'The nested repository is reported.');
  await cli(cwd, 'uninstall', '--confirm', '--include-requests');
  assert.equal(await readFile(template, 'utf8'), original);
  assert.equal((await git(nested, 'status', '--porcelain', '--', '_templates/feature-request.md')).stdout, '');
});

test('a configured authoring path through an internal directory link stays untouched', options, async t => {
  const cwd = await project(t), original = await readFile(join(cwd, 'fr-ready-check.json'), 'utf8');
  await mkdir(join(cwd, 'team-settings'));
  await writeFile(join(cwd, 'team-settings/ready.json'), original);
  await symlink(join(cwd, 'team-settings'), join(cwd, 'linked-settings'), 'junction');
  const path = join(cwd, '.werk/feature-workflow.json'), workflow = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...workflow, readyCheck: 'linked-settings/ready.json' }));
  const preview = await cli(cwd, 'uninstall', '--dry-run');
  assert.match(preview.keep.find(item => item.path === 'linked-settings/ready.json')?.reason ?? '', /reached through a link/);
  await cli(cwd, 'uninstall', '--confirm');
  assert.equal(await readFile(join(cwd, 'team-settings/ready.json'), 'utf8'), original);
});

test('custom metadata in a generated npm manifest belongs to the team', options, async t => {
  const cwd = await project(t);
  await seedWorkerPackage(cwd);
  const path = join(cwd, 'package.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
  const customized = JSON.stringify({ ...manifest, description: 'Team workspace', license: 'UNLICENSED', custom: { owner: 'team' } }, null, 2) + '\n';
  await writeFile(path, customized);
  const preview = await cli(cwd, 'uninstall', '--dry-run');
  assert.match(preview.keep.find(item => item.path === 'package.json')?.reason ?? '', /customized/);
  await cli(cwd, 'uninstall', '--confirm');
  assert.equal(await readFile(path, 'utf8'), customized);
});

test('uninstall preserves multiline foreign environment assignments verbatim', options, async t => {
  const cwd = await project(t), path = join(cwd, '.env');
  const value = 'OTHER_SETTING="first\nWERK_ENROLLMENT_TOKEN=part-of-another-value\nlast"\n' + await readFile(path, 'utf8');
  await writeFile(path, value, { mode: 0o600 });
  const footprint = await cli(cwd, 'footprint');
  assert.ok(!footprint.groups.environment.find(item => item.path === '.env').keys.includes('WERK_ENROLLMENT_TOKEN'));
  const preview = await cli(cwd, 'uninstall', '--dry-run', '--include-environment');
  assert.match(preview.keep.find(item => item.path === '.env')?.reason ?? '', /several lines/);
  await cli(cwd, 'uninstall', '--confirm', '--include-environment');
  assert.equal(await readFile(path, 'utf8'), value);
});

test('uninstall keeps environment values when only the root .env is ignored', options, async t => {
  const cwd = await project(t), path = join(cwd, '.env'), value = await readFile(path, 'utf8') + 'OTHER_SETTING=kept\n';
  await writeFile(path, value, { mode: 0o600 });
  await writeFile(join(cwd, '.gitignore'), '/.env\n!.env.example\n');
  const example = await readFile(join(cwd, '.env.example'), 'utf8') + 'OTHER_SETTING=example\n';
  await writeFile(join(cwd, '.env.example'), example);
  const preview = await cli(cwd, 'uninstall', '--dry-run', '--include-environment');
  for (const name of ['.env', '.env.example']) assert.match(preview.keep.find(item => item.path === name)?.reason ?? '', /temporary.*ignored/);
  await cli(cwd, 'uninstall', '--confirm', '--include-environment');
  assert.equal(await readFile(path, 'utf8'), value);
  assert.equal(await exists(join(cwd, '.env')), true);
  assert.equal(await readFile(join(cwd, '.env.example'), 'utf8'), example);
});

test('generated npm entrypoints include inventory and removal and unchanged manifests are removed', options, async t => {
  const cwd = await project(t);
  await seedWorkerPackage(cwd);
  const manifest = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
  for (const command of ['footprint', 'uninstall']) {
    assert.equal(workerNpmScripts()[command], 'node scripts/runtime/portable/npm-entry.mjs ' + command);
    assert.equal(manifest.scripts['worker:' + command], 'node bin/apps/worker/cli.mjs ' + command);
  }
  const preview = await cli(cwd, 'uninstall', '--dry-run');
  assert.ok(preview.remove.some(item => item.path === 'package.json'));
  await cli(cwd, 'uninstall', '--confirm');
  assert.equal(await exists(join(cwd, 'package.json')), false);
  assert.equal(await exists(join(cwd, '.werk/authoring')), false, 'The pristine authoring bundle is removed.');
});

for (const modification of ['script', 'manifest', 'unknown']) test('uninstall keeps customized authoring bundle: ' + modification, options, async t => {
  const cwd = await project(t), folder = join(cwd, '.werk/authoring');
  const script = await readFile(join(folder, 'feature-request.mjs'), 'utf8');
  const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'));
  if (modification === 'script') await writeFile(join(folder, 'feature-request.mjs'), script + '\n// Team customization\n');
  if (modification === 'manifest') await writeFile(join(folder, 'manifest.json'), JSON.stringify({ ...manifest, team: 'custom' }));
  if (modification === 'unknown') await writeFile(join(folder, 'team-notes.md'), 'Our authoring notes.\n');
  const beforeScript = await readFile(join(folder, 'feature-request.mjs'), 'utf8');
  const beforeManifest = await readFile(join(folder, 'manifest.json'), 'utf8');
  const preview = await cli(cwd, 'uninstall', '--dry-run');
  assert.match(preview.keep.find(item => item.path === '.werk/authoring')?.reason ?? '', /customized/);
  await cli(cwd, 'uninstall', '--confirm');
  assert.equal(await readFile(join(folder, 'feature-request.mjs'), 'utf8'), beforeScript);
  assert.equal(await readFile(join(folder, 'manifest.json'), 'utf8'), beforeManifest);
  if (modification === 'unknown') assert.equal(await readFile(join(folder, 'team-notes.md'), 'utf8'), 'Our authoring notes.\n');
});
