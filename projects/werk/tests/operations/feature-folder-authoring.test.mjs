import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, rename, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { featureFolder } from '../../scripts/runtime/portable/feature-folder.mjs';
import { planFeatureAuthoringMove } from '../../scripts/runtime/portable/feature-folder-authoring.mjs';
import { setupFeatureAuthoring, runFeatureAuthoring } from '../../scripts/runtime/portable/feature-authoring.mjs';
import { projectDefaults } from '../../scripts/runtime/portable/project.mjs';
import { initializeLegacyProjectWorker } from '../helpers/legacy-project-worker.mjs';
const app = resolve('bin/apps/worker'), digest = text => createHash('sha256').update(text).digest('hex');
async function project(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk authoring folder ')));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function fixture(t) {
  const root = await project(t), config = { schemaVersion: 1, features: { directory: 'features', provider: 'openai-api', pollMs: 500 } };
  const raw = JSON.stringify(config) + '\n';
  await mkdir(join(root, '.werk/worker'), { recursive: true });
  await writeFile(join(root, '.werk/worker.json'), raw, { mode: 0o600 });
  await writeFile(join(root, '.werk/worker-project.json'), JSON.stringify({ schemaVersion: 1, port: 4100 }), { mode: 0o600 });
  const authoring = await setupFeatureAuthoring(app, root);
  await writeFile(join(root, 'features/request.md'), 'Original request bytes\n');
  return { root, raw, config, authoring, call: (action, path) => featureFolder(action, { 'project-dir': root, ...(path ? { path } : {}) }) };
}

test('legacy fixture adopts an existing authoring folder and rejects policy or explicit-folder conflicts before installing files', async t => {
  const root = await project(t), authoring = await setupFeatureAuthoring(app, root, { featuresDirectory: 'team requests' });
  await assert.rejects(initializeLegacyProjectWorker(app, { 'project-dir': root, 'features-dir': 'another' }), /authoring workflow uses another/);
  await assert.rejects(access(join(root, 'bin')), { code: 'ENOENT' });
  await assert.rejects(access(join(root, '.werk/worker.json')), { code: 'ENOENT' });
  const check = join(root, authoring.workflow.readyCheck), original = await readFile(check, 'utf8');
  await writeFile(check, '{}');
  await assert.rejects(initializeLegacyProjectWorker(app, { 'project-dir': root }));
  await assert.rejects(access(join(root, 'bin')), { code: 'ENOENT' });
  await assert.rejects(access(join(root, '.werk/worker.json')), { code: 'ENOENT' });
  await writeFile(check, original);
  const initialized = await initializeLegacyProjectWorker(app, { 'project-dir': root });
  assert.equal(initialized.featuresDirectory, join(root, 'team requests'));
  assert.equal(JSON.parse(await readFile(initialized.configuration, 'utf8')).features.directory, 'team requests');
  assert.equal(initialized.authoring.workflow.requestsDirectory, 'team requests');
});

test('folder relocation preserves edited template and checks while updating workflow and generated Base', async t => {
  const f = await fixture(t), configPath = join(f.root, '.werk/feature-workflow.json');
  await mkdir(join(f.root, 'features/_checks'));
  await rename(join(f.root, f.authoring.workflow.readyCheck), join(f.root, 'features/_checks/ready.json'));
  await rename(join(f.root, f.authoring.workflow.base), join(f.root, 'features/_queue.base'));
  f.authoring.workflow.readyCheck = 'features/_checks/ready.json'; f.authoring.workflow.base = 'features/_queue.base';
  f.authoring.workflow.readyPrompt = 'features/_checks/ready.md'; f.authoring.workflow.donePrompt = 'done.txt';
  f.authoring.workflow.readyReviewPrompt = 'features/_checks/review.md';
  await writeFile(join(f.root, f.authoring.workflow.readyReviewPrompt), 'Review unresolved requirements.\n');
  await writeFile(join(f.root, f.authoring.workflow.readyPrompt), 'Team ready definition.\n');
  await writeFile(join(f.root, f.authoring.workflow.donePrompt), 'Team done definition.\n');
  await writeFile(configPath, JSON.stringify(f.authoring.workflow, null, 2) + '\n');
  const original = await readFile(configPath, 'utf8'), templatePath = join(f.root, f.authoring.workflow.template);
  const template = await readFile(templatePath, 'utf8') + '\n## Team checklist\n\n<!-- Team-owned guidance. -->\n';
  await writeFile(templatePath, template);
  const checkPath = join(f.root, f.authoring.workflow.readyCheck), check = JSON.parse(await readFile(checkPath, 'utf8')); check.version = 2;
  const checkText = JSON.stringify(check) + '\n'; await writeFile(checkPath, checkText);
  const baseBefore = (await readFile(join(f.root, f.authoring.workflow.base), 'utf8')).replaceAll('\n', '\r\n');
  await writeFile(join(f.root, f.authoring.workflow.base), baseBefore);
  const plan = await f.call('plan', 'requests/team'); assert.equal(plan.authoring.template, 'requests/team/_templates/feature-request.md');
  assert.equal(await readFile(configPath, 'utf8'), original); assert.equal(await readFile(join(f.root, f.authoring.workflow.base), 'utf8'), baseBefore);
  await f.call('set', 'requests/team');
  const workflow = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(workflow.requestsDirectory, 'requests/team'); assert.equal(workflow.template, 'requests/team/_templates/feature-request.md');
  assert.equal(await readFile(join(f.root, workflow.template), 'utf8'), template); assert.equal(workflow.readyCheck, 'requests/team/_checks/ready.json'); assert.equal(workflow.base, 'requests/team/_queue.base');
  assert.equal(await readFile(join(f.root, workflow.readyCheck), 'utf8'), checkText);
  assert.equal(workflow.readyPrompt, 'requests/team/_checks/ready.md'); assert.equal(workflow.donePrompt, 'done.txt');
  assert.equal(workflow.readyReviewPrompt, 'requests/team/_checks/review.md');
  assert.equal(await readFile(join(f.root, workflow.readyReviewPrompt), 'utf8'), 'Review unresolved requirements.\n');
  assert.equal(await readFile(join(f.root, workflow.readyPrompt), 'utf8'), 'Team ready definition.\n');
  assert.equal(await readFile(join(f.root, workflow.donePrompt), 'utf8'), 'Team done definition.\n');
  const movedBase = await readFile(join(f.root, workflow.base), 'utf8');
  assert.match(movedBase, /requests\/team/); assert.ok(movedBase.includes('\r\n'), 'preserve generated Base CRLF formatting');
  assert.equal(await readFile(join(f.root, 'requests/team/request.md'), 'utf8'), 'Original request bytes\n');
  const created = await runFeatureAuthoring(app, f.root, ['create', '--name', 'after-move.md', '--title', 'Request after folder move']);
  assert.equal(created.path, 'requests/team/after-move.md');
  await assert.rejects(access(join(f.root, '.werk/authoring/write.lock')), { code: 'ENOENT' });
  await assert.rejects(access(join(f.root, 'features')), { code: 'ENOENT' });
});

test('custom Base and active authoring writes fail before folder or workflow mutation', async t => {
  const f = await fixture(t), workflowPath = join(f.root, '.werk/feature-workflow.json'), basePath = join(f.root, f.authoring.workflow.base);
  const raw = await readFile(workflowPath, 'utf8'), base = await readFile(basePath, 'utf8'), customized = base + '\n# Team-owned view\n';
  await writeFile(basePath, customized);
  await assert.rejects(f.call('set', 'requests'), /Base is customized/);
  assert.equal(await readFile(basePath, 'utf8'), customized); assert.equal(await readFile(workflowPath, 'utf8'), raw);
  assert.equal(await readFile(join(f.root, '.werk/worker.json'), 'utf8'), f.raw);
  await assert.rejects(access(join(f.root, 'requests')), { code: 'ENOENT' });
  await assert.rejects(access(join(f.root, '.werk/feature-folder-change.json')), { code: 'ENOENT' });
  await writeFile(basePath, base); await writeFile(join(f.root, '.werk/authoring/write.lock'), 'active');
  await assert.rejects(f.call('set', 'requests'), /authoring write is active/);
  await assert.rejects(access(join(f.root, 'requests')), { code: 'ENOENT' });
  assert.equal(await readFile(workflowPath, 'utf8'), raw);
  await assert.rejects(access(join(f.root, '.werk/worker/worker.lock')), { code: 'ENOENT' });
});

test('interrupted authoring folder moves recover after each publication boundary', async t => {
  for (const phase of ['folder', 'base', 'workflow']) await t.test(phase, async t => {
    const f = await fixture(t), move = await planFeatureAuthoringMove(f.root, 'features', 'requests');
    const next = JSON.stringify({ ...f.config, features: { ...f.config.features, directory: 'requests' } }, null, 2) + '\n';
    await writeFile(join(f.root, '.werk/feature-folder-change.json'), JSON.stringify({ schemaVersion: 1, from: 'features', to: 'requests', before: digest(f.raw), after: digest(next), authoring: move.checkpoint }), { mode: 0o600 });
    await rename(join(f.root, 'features'), join(f.root, 'requests'));
    if (phase !== 'folder') await writeFile(join(f.root, move.next.base), move.afterBase);
    if (phase === 'workflow') await writeFile(join(f.root, '.werk/feature-workflow.json'), move.updated);
    await assert.rejects(projectDefaults({ 'project-dir': f.root }, true), /incomplete/);
    await f.call('set', 'requests');
    assert.equal((await f.call('get')).pendingChange, null);
    assert.equal(await readFile(join(f.root, '.werk/feature-workflow.json'), 'utf8'), move.updated);
    assert.equal(await readFile(join(f.root, move.next.base), 'utf8'), move.afterBase);
    assert.equal(await readFile(join(f.root, '.werk/worker.json'), 'utf8'), next);
    assert.equal(await readFile(join(f.root, 'requests/request.md'), 'utf8'), 'Original request bytes\n');
    await projectDefaults({ 'project-dir': f.root }, true);
  });
});
