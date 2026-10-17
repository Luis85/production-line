import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import filesystem, { mkdtemp, readFile, readdir, writeFile, mkdir, rm, access, symlink, link, chmod, stat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
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
  assert.equal(f.installed.files.length, 10);
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

test('repeated setup preserves an outdated committed authoring script but reports it', async () => {
  const f = await fixture();
  const path = join(f.root, '.werk/authoring/feature-request.mjs');
  assert.deepEqual(f.installed.warnings, []);
  // A Windows checkout may store the unchanged script with CRLF line endings.
  await writeFile(path, script.replace(/\n/g, '\r\n'));
  assert.deepEqual((await planFeatureAuthoring(f.root, { script })).warnings, []);
  const older = '// Werk 0.7.0 authoring script without definitionRef support\n';
  await writeFile(path, older);
  const planned = await planFeatureAuthoring(f.root, { script });
  assert.deepEqual(planned.warnings.map(warning => warning.code), ['authoring_script_outdated']);
  assert.match(planned.warnings[0].message, /\.werk\/authoring\/feature-request\.mjs.*preserved.*src\/worker\/dist\/worker\/authoring\/feature-request\.mjs/);
  const repeated = await initializeFeatureAuthoring(f.root, { script });
  assert.deepEqual(repeated.warnings.map(warning => warning.code), ['authoring_script_outdated']);
  assert.equal(repeated.files.find(file => file.path === '.werk/authoring/feature-request.mjs').status, 'preserved');
  assert.equal(await readFile(path, 'utf8'), older);
});

const scriptPath = '.werk/authoring/feature-request.mjs', manifestPath = '.werk/authoring/manifest.json';
const sha256 = text => createHash('sha256').update(text).digest('hex');
const released = '// Werk 0.7.0 authoring script without definitionRef support\nexport {};\n';
const statusOf = (result, path) => result.files.find(file => file.path === path)?.status;
const recorded = async root => JSON.parse(await readFile(join(root, manifestPath), 'utf8')).files[scriptPath].sha256;

test('setup records the installed script and refreshes it after an upgrade only while unmodified', async () => {
  // Simulate a kit installed by an older release, committed on Windows with CRLF line endings.
  const f = await fixture({ script: released });
  assert.equal(statusOf(f.installed, manifestPath), 'created');
  assert.equal(await recorded(f.root), sha256(released));
  await writeFile(join(f.root, scriptPath), released.replace(/\n/g, '\r\n'));
  const planned = await planFeatureAuthoring(f.root, { script });
  assert.deepEqual([statusOf(planned, scriptPath), statusOf(planned, manifestPath), planned.script.action], ['update', 'update', 'refresh']);
  assert.deepEqual(planned.warnings, []);
  assert.equal(await readFile(join(f.root, scriptPath), 'utf8'), released.replace(/\n/g, '\r\n'), 'planning never writes');
  const upgraded = await initializeFeatureAuthoring(f.root, { script });
  assert.deepEqual([statusOf(upgraded, scriptPath), statusOf(upgraded, manifestPath)], ['updated', 'updated']);
  assert.deepEqual(upgraded.warnings, []);
  assert.match(upgraded.next, /commit the refreshed authoring script/);
  assert.equal(await readFile(join(f.root, scriptPath), 'utf8'), script);
  assert.equal(await recorded(f.root), sha256(script));
  const repeated = await initializeFeatureAuthoring(f.root, { script });
  assert.ok(repeated.files.every(file => file.status === 'preserved'));
  await assert.rejects(access(join(f.root, '.werk/authoring/write.lock')));
});

test('a customized or unrecorded script is replaced only with an explicit matching revision', async () => {
  const f = await fixture({ script: released });
  const customized = released + '// Team rule: always add a reviewer.\n';
  await writeFile(join(f.root, scriptPath), customized);
  const preserved = await initializeFeatureAuthoring(f.root, { script });
  assert.equal(statusOf(preserved, scriptPath), 'preserved');
  assert.equal(statusOf(preserved, manifestPath), undefined, 'a customized script is never recorded as managed');
  assert.deepEqual(preserved.warnings.map(warning => [warning.code, warning.revision]), [['authoring_script_outdated', sha256(customized)]]);
  assert.match(preserved.warnings[0].message, new RegExp('feature setup --if-match ' + sha256(customized)));
  assert.equal(await readFile(join(f.root, scriptPath), 'utf8'), customized);
  assert.equal(await recorded(f.root), sha256(released));
  await assert.rejects(initializeFeatureAuthoring(f.root, { script, ifMatch: sha256(released) }), /another revision/);
  await assert.rejects(initializeFeatureAuthoring(f.root, { script, ifMatch: 'HEAD' }), /64-character SHA-256/);
  assert.equal(await readFile(join(f.root, scriptPath), 'utf8'), customized);
  const replaced = await initializeFeatureAuthoring(f.root, { script, ifMatch: sha256(customized) });
  assert.deepEqual([statusOf(replaced, scriptPath), statusOf(replaced, manifestPath)], ['updated', 'updated']);
  assert.equal(await readFile(join(f.root, scriptPath), 'utf8'), script);
  assert.equal(await recorded(f.root), sha256(script));

  // Projects set up before the manifest existed have no record: the same explicit path applies.
  const legacy = await fixture({ script: released });
  await rm(join(legacy.root, manifestPath));
  const unrecorded = await initializeFeatureAuthoring(legacy.root, { script });
  assert.deepEqual(unrecorded.warnings.map(warning => warning.code), ['authoring_script_outdated']);
  await assert.rejects(access(join(legacy.root, manifestPath)));
  const adopted = await initializeFeatureAuthoring(legacy.root, { script, ifMatch: sha256(released) });
  assert.deepEqual([statusOf(adopted, scriptPath), statusOf(adopted, manifestPath)], ['updated', 'created']);
  assert.equal(await recorded(legacy.root), sha256(script));
});

test('a current script without a record gains one, and --if-match needs an installed script', async () => {
  const f = await fixture();
  await rm(join(f.root, manifestPath));
  const recordedNow = await initializeFeatureAuthoring(f.root, { script });
  assert.deepEqual([statusOf(recordedNow, scriptPath), statusOf(recordedNow, manifestPath)], ['preserved', 'created']);
  assert.deepEqual(recordedNow.warnings, []);
  const empty = await mkdtemp(join(scratch, 'project-'));
  await assert.rejects(initializeFeatureAuthoring(empty, { script, ifMatch: sha256(script) }), /none is installed/);
  await assert.rejects(access(join(empty, '.werk')));
});

test('a guarded replacement refuses a file that changed after inspection', async () => {
  const { replaceAuthoringFile } = await import(pathToFileURL(join(project, 'src/worker/dist/worker/infrastructure/feature-authoring-files.js')).href);
  const f = await fixture();
  await writeFile(join(f.root, scriptPath), 'changed by a teammate\n');
  await assert.rejects(replaceAuthoringFile(f.root, scriptPath, 'replacement\n', sha256(script)), /changed during setup/);
  assert.equal(await readFile(join(f.root, scriptPath), 'utf8'), 'changed by a teammate\n');
  assert.deepEqual((await readdir(join(f.root, '.werk/authoring'))).filter(name => name.endsWith('.tmp')), []);
});

test('portable feature setup accepts --if-match and rejects a malformed revision before writing', async () => {
  const f = await fixture({ script: released });
  await writeFile(join(f.root, scriptPath), released + '// customized\n');
  const cli = new URL('../../scripts/runtime/portable/cli.mjs', import.meta.url).href;
  const run = (...args) => execFileSync(process.execPath, ['--input-type=module', '-e', `import { main } from ${JSON.stringify(cli)}; await main('worker', process.argv.slice(1));`, 'feature', 'setup', '--project-dir', f.root, ...args], { encoding: 'utf8', stdio: 'pipe' });
  assert.throws(() => run('--if-match', 'not-a-revision'), error => error.status === 2 && /64-character SHA-256/.test(error.stderr));
  const warned = JSON.parse(run());
  const revision = warned.warnings.find(warning => warning.code === 'authoring_script_outdated').revision;
  const replaced = JSON.parse(run('--if-match', revision));
  assert.equal(statusOf(replaced, scriptPath), 'updated');
  assert.equal(await readFile(join(f.root, scriptPath), 'utf8'), await readFile(join(project, 'src/worker/dist/worker/authoring/feature-request.mjs'), 'utf8'));
});


test('managed refresh preserves executable permission bits without retaining set-ID bits', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture({ script: released }), path = join(f.root, scriptPath);
  await chmod(path, 0o4755);
  await initializeFeatureAuthoring(f.root, { script });
  assert.equal((await stat(path)).mode & 0o7777, 0o755);
  assert.equal(await readFile(path, 'utf8'), script);
  assert.equal(await recorded(f.root), sha256(script));
});

for (const failingStep of ['writeFile', 'sync']) test('managed refresh cleans temporary files after a failed ' + failingStep, async t => {
  const f = await fixture({ script: released });
  const manifest = await readFile(join(f.root, manifestPath), 'utf8');
  const originalOpen = filesystem.open;
  t.mock.method(filesystem, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).includes('._authoring-')) t.mock.method(handle, failingStep, async () => { throw Object.assign(Error('Injected authoring storage failure'), { code: 'EIO' }); });
    return handle;
  });
  syncBuiltinESMExports();
  try { await assert.rejects(initializeFeatureAuthoring(f.root, { script }), error => error.code === 'EIO'); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(await readFile(join(f.root, scriptPath), 'utf8'), released);
  assert.equal(await readFile(join(f.root, manifestPath), 'utf8'), manifest);
  assert.deepEqual((await readdir(join(f.root, '.werk/authoring'))).filter(name => name.endsWith('.tmp') || name === 'write.lock'), []);
  await initializeFeatureAuthoring(f.root, { script });
  assert.equal(await readFile(join(f.root, scriptPath), 'utf8'), script, 'retry safely completes the interrupted upgrade');
  assert.equal(await recorded(f.root), sha256(script));
});

test('planning and setup reject an oversized manifest before creating missing kit files', async () => {
  const f = await fixture(), manifest = ' '.repeat(16385);
  await writeFile(join(f.root, manifestPath), manifest);
  await rm(join(f.root, '.agents'), { recursive: true });
  for (const action of [planFeatureAuthoring, initializeFeatureAuthoring]) {
    await assert.rejects(action(f.root, { script }), /bounded regular files/);
    await assert.rejects(access(join(f.root, '.agents')));
    await assert.rejects(access(join(f.root, '.werk/authoring/write.lock')));
    assert.equal(await readFile(join(f.root, manifestPath), 'utf8'), manifest);
    assert.equal(await readFile(join(f.root, scriptPath), 'utf8'), script);
  }
});

test('the copied script validates and readies vault requests with Unicode approved paths', async () => {
  const f = await fixture();
  const entry = join(f.root, '.werk/authoring/feature-request.mjs');
  const created = JSON.parse(execFileSync(process.execPath, [entry, 'create', '--name', 'Zollabwicklung prüfen.md', '--title', 'Zollabwicklung prüfen'], { cwd: f.root, encoding: 'utf8' }));
  const draft = await completedDraft(f, 'Wareneingang.md');
  const paths = ['docs/requirements/FA-9_Material-Logistics/LACF-REQ-033 Warenein- und -ausgang einschließlich Zoll abwickeln.md', "docs/Kunden's Änderungen (Größe) & Fristen – Prüfung → Freigabe.md"];
  const unicode = draft.raw.replace('paths: [src/search.ts]', 'paths:\n' + paths.map(path => '  - ' + JSON.stringify(path.normalize('NFD'))).join('\n'));
  await writeFile(draft.fullPath, unicode);
  const valid = JSON.parse(execFileSync(process.execPath, [entry, 'validate', '--file', draft.path], { cwd: f.root, encoding: 'utf8' }));
  assert.equal(valid.valid, true, JSON.stringify(valid.errors));
  assert.deepEqual(valid.input.paths, paths);
  const ready = await f.run(['ready', '--file', draft.path, '--if-match', valid.revision]);
  assert.equal(ready.valid, true);
  assert.match(created.path, /Zollabwicklung prüfen\.md$/);
  await writeFile(draft.fullPath, draft.raw.replace('paths: [src/search.ts]', 'paths: [docs/nul.md]'));
  const device = await f.run(['validate', '--file', draft.path]);
  assert.equal(device.valid, false);
  assert.match(device.errors[0].message, /safe relative non-secret/);
});
