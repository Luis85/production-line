import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ownWorkspace } from '../helpers/workspace-processes.mjs';
import { testErrorOutput } from '../helpers/process-errors.mjs';
import { createRepositoryWorktree, repositoryRoot } from '../../src/worker/dist/worker/infrastructure/repositories-git.js';
import { prepareProcessRuntime } from '../../src/worker/dist/shared/process/launcher.js';
import { cli, exec, exists, files, git, project } from './project-worker-uninstall-fixture.mjs';

test('footprint inventories every group with existence, size and Git tracking without printing contents', { timeout: 180000 }, async t => {
  const cwd = await project(t), value = await cli(cwd, 'footprint');
  assert.deepEqual(Object.keys(value.groups), ['app', 'retained', 'state', 'configuration', 'authoring', 'requests', 'integrations', 'environment', 'worktrees']);
  assert.equal(value.git, 'repository'); assert.equal(value.worker.state, 'stopped');
  const find = (group, path) => value.groups[group].find(entry => entry.path === path);
  assert.equal(find('app', 'bin/apps/worker').exists, true); assert.ok(find('app', 'bin/apps/worker').size > 0);
  assert.equal(find('retained', 'bin/apps/.worker-update').exists, false);
  assert.equal(find('state', '.werk/worker').type, 'directory');
  assert.equal(find('configuration', '.werk/worker.json').tracked, true);
  assert.equal(find('configuration', '.werk/compose.worker.yaml').tracked, false);
  assert.equal(find('authoring', 'Feature Requests.base').tracked, true);
  assert.equal(find('requests', 'features').exists, true);
  assert.equal(find('integrations', '.codex/werk-worker.md').managed, true);
  assert.deepEqual(find('environment', '.env').keys.sort(), ['WERK_WORKER_CONFIG', 'WERK_WORKER_HOST', 'WERK_WORKER_PORT', 'WERK_WORKER_STATE_DIR', 'WERK_WORKER_TOKEN']);
  const token = /WERK_WORKER_TOKEN='?([a-f0-9]{64})/.exec(await readFile(join(cwd, '.env'), 'utf8'))[1];
  assert.doesNotMatch(JSON.stringify(value), new RegExp(token)); assert.doesNotMatch(JSON.stringify(value), /Keep me/);
});

test('uninstall refuses without a mode, previews without changes and keeps tracked files and requests on confirm', { timeout: 180000 }, async t => {
  const cwd = await project(t);
  await writeFile(join(cwd, '.claude/skills/werk-worker/SKILL.md'), '# Edited by the team\n');
  await assert.rejects(cli(cwd, 'uninstall'), error => /uninstall --dry-run, then run uninstall --confirm/.test(testErrorOutput(error, 'stderr')));
  await assert.rejects(cli(cwd, 'uninstall', '--dry-run', '--confirm'), error => /either --dry-run or --confirm/.test(testErrorOutput(error, 'stderr')));
  await assert.rejects(exec(process.execPath, ['cli.mjs', 'uninstall', '--dry-run'], { cwd: join(cwd, 'bin/apps/worker') }), error => /from the project directory/.test(testErrorOutput(error, 'stderr')));
  const before = await files(cwd), preview = await cli(cwd, 'uninstall', '--dry-run');
  assert.deepEqual(await files(cwd), before, 'A dry run changes nothing.');
  assert.equal(preview.dryRun, true);
  const removes = preview.remove.map(item => item.path), keeps = Object.fromEntries(preview.keep.map(item => [item.path, item.reason]));
  for (const path of ['bin/apps/worker', '.werk/worker', '.werk/compose.worker.yaml', '.codex/werk-worker.md']) assert.ok(removes.includes(path), path);
  assert.match(keeps['.werk/worker.json'], /Tracked by Git/); assert.match(keeps.features, /--include-requests/);
  assert.match(keeps['.env'], /--include-environment/); assert.match(keeps['.claude/skills/werk-worker/SKILL.md'], /edited|owned/i);
  const result = await cli(cwd, 'uninstall', '--confirm');
  assert.equal(result.ok, true);
  assert.deepEqual(result.removed.map(item => item.path).filter(path => !removes.includes(path)), [], 'Confirm removes exactly the previewed paths.');
  for (const path of ['bin/apps/worker', '.werk/worker', '.werk/provider-home', '.werk/compose.worker.yaml', '.werk/worker-project.json', '.codex', 'features/_templates', 'fr-ready-check.json']) assert.equal(await exists(join(cwd, path)), false, path);
  for (const path of ['.werk/worker.json', '.werk/feature-workflow.json', 'Feature Requests.base', 'features/team-request.md', '.env', '.claude/skills/werk-worker/SKILL.md', 'README.md']) assert.equal(await exists(join(cwd, path)), true, path);
  assert.equal((await git(cwd, 'status', '--porcelain', '--', '.werk/worker.json', 'Feature Requests.base')).stdout, '', 'Tracked files are unchanged.');
});

test('uninstall includes requests and environment entries only on request and never deletes tracked request files', { timeout: 180000 }, async t => {
  const cwd = await project(t);
  await git(cwd, 'add', '-f', 'features/team-request.md'); await git(cwd, 'commit', '-q', '-m', 'request');
  await writeFile(join(cwd, 'features/local-draft.md'), '---\ntitle: Local draft\n---\n');
  await writeFile(join(cwd, '.env'), (await readFile(join(cwd, '.env'), 'utf8')) + 'OTHER_SETTING=kept\n');
  const result = await cli(cwd, 'uninstall', '--confirm', '--include-requests', '--include-environment');
  assert.equal(result.ok, true);
  assert.equal(await exists(join(cwd, 'features/local-draft.md')), false);
  assert.equal(await exists(join(cwd, 'features/team-request.md')), true);
  assert.equal(await readFile(join(cwd, '.env'), 'utf8'), 'OTHER_SETTING=kept\n');
  assert.deepEqual((await readdir(cwd)).filter(name => name.startsWith('.werk-env-')), [], 'The atomic rewrite leaves no temporary folder.');
  await git(cwd, 'check-ignore', '-q', '.werk-env-probe/.env'); // The temporary .env inside it matches the generated rule.
  assert.equal(await exists(join(cwd, '.env.example')), false);
  assert.match(await readFile(join(cwd, '.gitignore'), 'utf8'), /^\.env$/m);
});

test('uninstall keeps changed and unowned task worktrees, removes clean owned ones and reports each', { timeout: 180000 }, async t => {
  const cwd = await project(t);
  const config = JSON.parse(await readFile(join(cwd, '.werk/worker.json'), 'utf8'));
  await writeFile(join(cwd, '.werk/worker.json'), JSON.stringify({ ...config, repositories: { items: [{ id: 'project', path: cwd }] } }), { mode: 0o600 });
  // Prepare native containment before the unchanged repository-operation deadlines.
  await prepareProcessRuntime(cwd, t.signal);
  const root = await repositoryRoot(cwd, AbortSignal.timeout(30000));
  const clean = await createRepositoryWorktree(root, 'project', 'clean-task', AbortSignal.timeout(60000));
  const changed = await createRepositoryWorktree(root, 'project', 'changed-task', AbortSignal.timeout(60000));
  const unowned = await createRepositoryWorktree(root, 'other', 'foreign-task', AbortSignal.timeout(60000));
  await writeFile(join(changed.path, 'work-in-progress.txt'), 'unsaved\n');
  const listed = (await cli(cwd, 'footprint')).groups.worktrees;
  assert.deepEqual(listed.map(item => [item.repositoryId, item.state, item.owned]).sort(), [['project', 'present', false], ['project', 'present', true], ['project', 'present', true]]);
  const preview = await cli(cwd, 'uninstall', '--dry-run');
  assert.ok(preview.remove.some(item => item.path === clean.path));
  assert.equal(await exists(clean.path), true, 'A dry run keeps worktrees.');
  const result = await cli(cwd, 'uninstall', '--confirm');
  assert.ok(result.removed.some(item => item.group === 'worktrees' && item.path === clean.path));
  assert.match(result.kept.find(item => item.path === changed.path).reason, /uncommitted or untracked changes/);
  assert.match(result.kept.find(item => item.path === unowned.path).reason, /not owned by this worker/);
  assert.equal(await exists(clean.path), false);
  assert.equal(await readFile(join(changed.path, 'work-in-progress.txt'), 'utf8'), 'unsaved\n');
  assert.equal(await exists(unowned.path), true);
  assert.ok(result.manual.some(step => /git worktree remove/.test(step)));
});

test('uninstall --confirm refuses while the worker runs unless --stop is given', { timeout: 180000 }, async t => {
  const cwd = await project(t, { cleanup: false });
  let running = false;
  await ownWorkspace(t, cwd, async () => { if (running) await cli(cwd, 'stop'); });
  await cli(cwd, 'start', '--port', '0'); running = true;
  assert.equal((await cli(cwd, 'footprint')).worker.state, 'running');
  assert.equal((await cli(cwd, 'uninstall', '--dry-run')).worker.stopRequired, true);
  await assert.rejects(cli(cwd, 'uninstall', '--confirm'), error => /worker is running/.test(testErrorOutput(error, 'stderr')));
  assert.equal(await exists(join(cwd, 'bin/apps/worker')), true);
  const result = await cli(cwd, 'uninstall', '--confirm', '--stop'); running = false;
  assert.equal(result.worker.state, 'stopped'); assert.equal(await exists(join(cwd, '.werk/worker')), false);
});
