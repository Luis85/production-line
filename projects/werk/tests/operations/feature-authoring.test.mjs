import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, access, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { buildFeatureAuthoring } from '../../scripts/release/feature-authoring.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'werk-authoring-tests-'));
after(() => rm(scratch, { recursive: true, force: true }));
await buildFeatureAuthoring(project, join(scratch, 'bundle'));
const bundle = join(scratch, 'bundle/worker/authoring/feature-request.mjs');
const script = await readFile(bundle, 'utf8');
const { initializeFeatureAuthoring, planFeatureAuthoring, runFeatureAuthoring } = await import(pathToFileURL(bundle).href);
async function fixture(options = {}) {
  const root = await mkdtemp(join(scratch, 'project-'));
  const installed = await initializeFeatureAuthoring(root, { script, ...options });
  const run = args => runFeatureAuthoring(args, root);
  return { root, installed, run };
}
async function completedDraft(f, name = 'search.md') {
  const created = await f.run(['create', '--name', name, '--title', 'Find a matching request']);
  const path = join(f.root, created.path);
  let raw = await readFile(path, 'utf8');
  raw = raw.replace('paths: []', 'paths: [src/search.ts]')
    .replace('<!-- Explain the problem, who experiences it, and the observable outcome. -->', 'Let operators find a request by its title.')
    .replace('<!-- Describe constraints, relevant behavior, and what is outside this request. -->', 'Keep existing request IDs and ordering unchanged.')
    .replace('<!-- Add one or more concrete, verifiable checklist items. -->', '- [ ] A title query shows the matching request.')
    .replace('<!-- Explain how each outcome will be checked and what evidence reviewers need. -->', 'Run the search regression test and review a keyboard-only search.');
  await writeFile(path, raw);
  return { ...created, raw, fullPath: path };
}

test('authoring setup installs a standalone team kit and preserves customized files', async () => {
  const f = await fixture({ featuresDirectory: 'requests/features' });
  assert.equal(f.installed.workflow.requestsDirectory, 'requests/features');
  assert.equal(f.installed.files.length, 9);
  await assert.rejects(access(join(f.root, 'bin/apps/worker')));
  await assert.rejects(access(join(f.root, '.werk/worker.json')));
  const base = parse(await readFile(join(f.root, 'Feature Requests.base'), 'utf8'));
  assert.equal(base.views[0].type, 'table');
  assert.ok(base.filters.and.includes('file.folder == "requests/features"'));
  assert.match(await readFile(join(f.root, '.agents/skills/create-feature-request/SKILL.md'), 'utf8'), /# Create Feature Request/);
  await writeFile(join(f.root, f.installed.workflow.template), '# A customized legacy template\n');
  const repeated = await initializeFeatureAuthoring(f.root, { script });
  assert.ok(repeated.files.every(file => file.status === 'preserved'));
  assert.equal(repeated.warnings[0].code, 'template_update_required');
  assert.equal(await readFile(join(f.root, f.installed.workflow.template), 'utf8'), '# A customized legacy template\n');
});

test('copied script creates stable drafts without worker or node_modules and fails incomplete readiness', async () => {
  const f = await fixture();
  const entry = join(f.root, '.werk/authoring/feature-request.mjs');
  const created = JSON.parse(execFileSync(process.execPath, [entry, 'create', '--name', 'offline.md', '--title', 'Offline request'], { cwd: f.root, encoding: 'utf8', env: { ...process.env, WERK_APP_TOKEN: '', NODE_PATH: '' } }));
  assert.match(created.id, /^fr-[a-f0-9-]{36}$/);
  assert.equal(created.status, 'draft');
  await assert.rejects(f.run(['create', '--name', 'offline.md', '--title', 'Overwrite']), /already exists/);
  const result = await f.run(['validate', '--file', created.path]);
  assert.equal(result.valid, false);
  const ready = await f.run(['ready', '--file', created.path, '--if-match', created.revision]);
  assert.equal(ready.valid, false);
  assert.match(await readFile(join(f.root, created.path), 'utf8'), /status: draft/);
  assert.throws(() => execFileSync(process.execPath, [entry, 'validate', '--file', created.path], { cwd: f.root, stdio: 'pipe' }), error => error.status === 2);
});

test('ready rechecks current rules, rejects stale edits, preserves ID/body, and cannot repeat', async () => {
  const f = await fixture(), draft = await completedDraft(f);
  const valid = await f.run(['validate', '--file', draft.path]);
  assert.equal(valid.valid, true);
  await assert.rejects(f.run(['ready', '--file', draft.path, '--if-match', draft.revision]), /changed/);
  const checkPath = join(f.root, 'fr-ready-check.json');
  const policy = JSON.parse(await readFile(checkPath, 'utf8'));
  policy.rules.patch.push({ id: 'two-criteria', fact: 'input.criteriaCount', op: 'gte', value: 2 });
  await writeFile(checkPath, JSON.stringify(policy));
  const held = await f.run(['ready', '--file', draft.path, '--if-match', valid.revision]);
  assert.equal(held.valid, false);
  assert.ok(held.errors.some(error => error.message.includes('two-criteria')));
  const revised = draft.raw.replace('- [ ] A title query shows the matching request.', '- [ ] A title query shows the matching request.\n- [ ] Clearing the query restores the queue.');
  await writeFile(draft.fullPath, revised);
  const current = await f.run(['validate', '--file', draft.path]);
  assert.equal(current.valid, true);
  const ready = await f.run(['ready', '--file', draft.path, '--if-match', current.revision]);
  assert.equal(ready.status, 'ready'); assert.equal(ready.id, draft.id);
  const saved = await readFile(draft.fullPath, 'utf8');
  assert.equal(saved.split('\n---\n')[1], revised.split('\n---\n')[1]);
  await assert.rejects(f.run(['ready', '--file', draft.path, '--if-match', ready.revision]), /unmanaged draft/);
});

test('custom template requirements are current authority and worker metadata blocks submission', async () => {
  const f = await fixture(), draft = await completedDraft(f);
  const templatePath = join(f.root, f.installed.workflow.template);
  await writeFile(templatePath, (await readFile(templatePath, 'utf8')) + '\n## Rollback plan\n\n<!-- Explain recovery. -->\n');
  const invalid = await f.run(['validate', '--file', draft.path]);
  assert.equal(invalid.valid, false); assert.match(invalid.errors[0].message, /rollback plan/);
  await writeFile(draft.fullPath, draft.raw + '\n## Rollback plan\n\nRevert the isolated search change after review.\n');
  assert.equal((await f.run(['validate', '--file', draft.path])).valid, true);
  await writeFile(draft.fullPath, draft.raw.replace('status: draft', 'status: draft\nwerk: {taskId: owned}'));
  const current = await f.run(['validate', '--file', draft.path]);
  await assert.rejects(f.run(['ready', '--file', draft.path, '--if-match', current.revision]), /unmanaged draft/);
});

test('setup and authoring refuse linked destinations and unsafe paths without outside writes', async t => {
  const root = await mkdtemp(join(scratch, 'links-')), outside = await mkdtemp(join(scratch, 'outside-'));
  try { await symlink(outside, join(root, '.agents'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Directory symlinks are unavailable'); return; } throw error; }
  await assert.rejects(initializeFeatureAuthoring(root, { script }), /real project directories/);
  await assert.rejects(access(join(root, '.werk/feature-workflow.json')));
  await assert.rejects(access(join(outside, 'skills/create-feature-request/SKILL.md')));
  const f = await fixture();
  await assert.rejects(f.run(['create', '--name', '../escape.md', '--title', 'Unsafe']), /new Markdown/);
  await assert.rejects(f.run(['create', '--name', 'CON.md', '--title', 'Unsafe']), /safe repository-relative/);
  await assert.rejects(f.run(['validate', '--file', '../outside.md']), /inside the configured queue/);
  const draft = await completedDraft(f);
  await link(draft.fullPath, join(f.root, 'linked.md'));
  await assert.rejects(f.run(['validate', '--file', draft.path]), /without links/);
});

test('malformed check files block setup before installing any kit files', async () => {
  const root = await mkdtemp(join(scratch, 'invalid-'));
  await writeFile(join(root, 'fr-ready-check.json'), JSON.stringify({ schemaVersion: 1, stage: 'done' }));
  await assert.rejects(initializeFeatureAuthoring(root, { script }), /ready feature check/);
  await assert.rejects(access(join(root, '.werk/feature-workflow.json')));
  await assert.rejects(access(join(root, '.agents')));
});

test('read-only setup plan adopts the existing worker queue without installing files', async () => {
  const root = await mkdtemp(join(scratch, 'existing-worker-'));
  await mkdir(join(root, '.werk'));
  await writeFile(join(root, '.werk/worker.json'), JSON.stringify({ schemaVersion: 1, features: { directory: 'requests/team', provider: 'codex-cli' } }));
  const plan = await planFeatureAuthoring(root, { script });
  assert.equal(plan.workflow.requestsDirectory, 'requests/team');
  assert.ok(plan.files.every(file => file.status === 'missing'));
  await assert.rejects(access(join(root, '.werk/feature-workflow.json')));
  await assert.rejects(access(join(root, '.agents')));
  await initializeFeatureAuthoring(root, { script });
  await assert.rejects(planFeatureAuthoring(root, { script, featuresDirectory: 'different' }), /different feature folder/);
});

test('authoring setup and submission respect the shared write lock and reject control-file scope', async () => {
  const f = await fixture(), draft = await completedDraft(f);
  const lock = join(f.root, '.werk/authoring/write.lock');
  await writeFile(lock, 'folder move');
  await assert.rejects(initializeFeatureAuthoring(f.root, { script }), /Another authoring write/);
  const valid = await f.run(['validate', '--file', draft.path]);
  await assert.rejects(f.run(['ready', '--file', draft.path, '--if-match', valid.revision]), /Another authoring write/);
  assert.equal(await readFile(lock, 'utf8'), 'folder move');
  await rm(lock);
  for (const path of ['.env', 'fr-ready-check.json', '.werk/feature-workflow.json']) {
    await writeFile(draft.fullPath, draft.raw.replace('src/search.ts', path));
    const validation = await f.run(['validate', '--file', draft.path]);
    assert.equal(validation.valid, false, path);
    const result = await f.run(['ready', '--file', draft.path, '--if-match', validation.revision]);
    assert.equal(result.valid, false, path);
    assert.match(await readFile(draft.fullPath, 'utf8'), /status: draft/);
  }
});

test('standalone authoring runs through a symlinked parent and stays inert when imported', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  const alias = join(scratch, 'invocation-alias');
  await symlink(f.root, alias, 'dir');
  const entry = join(alias, '.werk/authoring/feature-request.mjs');
  const created = JSON.parse(execFileSync(process.execPath, [entry, 'create', '--name', 'aliased.md', '--title', 'Aliased invocation'], { cwd: alias, encoding: 'utf8' }));
  assert.equal(created.status, 'draft');
  assert.match(await readFile(join(f.root, created.path), 'utf8'), /title: Aliased invocation/);
  assert.throws(() => execFileSync(process.execPath, [entry, 'validate', '--file', created.path], { cwd: alias, stdio: 'pipe' }), error => error.status === 2 && JSON.parse(error.stdout).valid === false);
  const moduleUrl = pathToFileURL(entry).href;
  const importer = join(f.root, 'import-only.mjs');
  await writeFile(importer, 'await import(' + JSON.stringify(moduleUrl) + '); console.log("imported");\n');
  const imported = execFileSync(process.execPath, [importer, 'create', '--name', 'must-not-exist.md', '--title', 'Not requested'], { cwd: f.root, encoding: 'utf8' });
  assert.equal(imported.trim(), 'imported');
  await assert.rejects(access(join(f.root, 'features/must-not-exist.md')), { code: 'ENOENT' });
  for (const missing of [undefined, join(scratch, 'missing-entry.mjs')]) {
    const code = 'process.argv[1] = ' + (missing === undefined ? 'undefined' : JSON.stringify(missing)) + '; await import(' + JSON.stringify(moduleUrl) + '); console.log("imported");';
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: f.root, encoding: 'utf8' }).trim(), 'imported');
  }
});
