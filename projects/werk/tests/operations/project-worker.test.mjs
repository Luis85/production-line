import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { initializeWorker } from '../../scripts/runtime/portable/project.mjs';
import { ownWorkspace } from '../helpers/workspace-processes.mjs';
const exec = promisify(execFile), installer = resolve('bin/apps/worker/cli.mjs');
async function project(t, cleanup = true) { const path = await realpath(await mkdtemp(join(tmpdir(), 'werk project worker '))); if (cleanup) t.after(() => rm(path, { recursive: true, force: true })); return path; }
async function cli(entry, cwd, ...args) { const result = await exec(process.execPath, [entry, ...args], { cwd, timeout: 45000, maxBuffer: 1048576 }); return JSON.parse(result.stdout); }
async function eventually(check) { for (let n = 0; n < 200; n++) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); } throw Error('Timed out waiting for feature workflow'); }
const front = raw => parse(/^---\n([\s\S]*?)\n---\n/.exec(raw)[1]);
test('project init installs a self-contained worker, configurable template and Docker launch without overwriting edits', async t => {
  const cwd = await project(t), initial = await cli(installer, cwd, 'init', '--features-dir', 'requests/features', '--provider', 'openai-api', '--port', '4207');
  const entry = join(cwd, 'bin/apps/worker/cli.mjs'); assert.equal(initial.featuresDirectory, join(cwd, 'requests/features'));
  assert.equal((await cli(entry, cwd, 'feature', 'folder', 'get')).path, 'requests/features');
  assert.equal((await cli(entry, cwd, 'feature', 'folder', 'plan', '--path', 'new-requests')).changed, true);
  const template = join(initial.featuresDirectory, '_templates/feature-request.md'); assert.equal(front(await readFile(template, 'utf8')).status, 'draft');
  assert.equal(front(await readFile(template, 'utf8')).provider, 'openai-api');
  assert.equal(initial.intake.mode, 'shared_git'); assert.equal(initial.intake.connectionRequired, true);
  assert.match(initial.intake.setup, /shared configure/);
  assert.match(initial.next, /provider configure/); assert.doesNotMatch(initial.next, /shared setup/);
  await writeFile(template, '# User template\n'); await cli(entry, cwd, 'init'); assert.equal(await readFile(template, 'utf8'), '# User template\n');
  const compose = parse(await readFile(join(cwd, '.werk/compose.worker.yaml'), 'utf8')); assert.match(compose.services.worker.image, /node:24/); assert.equal(compose.services.worker.working_dir, '/project'); assert.equal(compose.services.worker.volumes[0].source, '..'); assert.match(compose.services.worker.ports[0], /4207/);
  assert.match(await readFile(join(cwd, '.werk/.gitignore'), 'utf8'), /worker\//);
  assert.match(await readFile(join(initial.featuresDirectory, '.gitignore'), 'utf8'), /^_questions\/$/m);
  const output = await exec(process.execPath, [entry, 'feature', 'template'], { cwd }); assert.equal(front(output.stdout).status, 'draft');
  await assert.rejects(cli(installer, cwd, 'init'), /worker app already exists/);
  await assert.rejects(cli(entry, cwd, 'init', '--features-dir', '../outside'), /inside the project/);
  await assert.rejects(cli(entry, cwd, 'init', '--port', '4210'), /Existing project port differs/);
  assert.equal(JSON.parse(await readFile(join(cwd, '.werk/worker-project.json'), 'utf8')).port, 4207);
});
test('installed native worker consumes files, exports review patches and keeps task identity across restart', { skip: process.platform === 'win32', timeout: 120000 }, async t => {
  const cwd = await project(t, false), entry = join(cwd, 'bin/apps/worker/cli.mjs'); let running = false;
  await ownWorkspace(t, cwd, async () => { if (running) await cli(entry, cwd, 'stop'); });
  await cli(installer, cwd, 'init');
  const configPath = join(cwd, '.werk/worker.json'), config = JSON.parse(await readFile(configPath, 'utf8')); config.features.pollMs = 250; await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const provider = join(cwd, 'provider-fixture'); await writeFile(provider, `#!${process.execPath}\nlet input='';for await(const p of process.stdin)input+=p;const text=input.includes('Implement the requested changes')?JSON.stringify({summary:'Review fixture patch',files:[{path:'approved.txt',content:'changed\\n'}]}):'Feature protocol fixture completed.';console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));\n`, { mode: 0o700 });
  let started = await cli(entry, cwd, 'start', '--port', '0'); running = true;
  const token = (await readFile(join(cwd, '.werk/worker/webview-token'), 'utf8')).trim();
  const api = async (path, body) => { const r = await fetch(started.url + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const value = await r.json(); assert.ok(r.ok, value.error); return value; };
  await api('/api/settings', { provider: { id: 'codex-cli', executable: provider } });
  let features = join(cwd, 'features'); await writeFile(join(features, 'chat.md'), '---\nschemaVersion: 1\ntitle: Native file intake\nstatus: ready\n---\nDescribe the next step.\n');
  await writeFile(join(cwd, 'approved.txt'), 'original\n'); await writeFile(join(features, 'patch.md'), '---\nschemaVersion: 1\ntitle: Approved patch\nstatus: ready\nmode: patch\npaths: [approved.txt]\n---\nChange the approved file.\n');
  await eventually(async () => { const view = await api('/api/features'); return view.records.length === 2 && view.records.every(r => ['completed', 'review'].includes(r.status) && r.result) && (await readFile(join(features, 'chat.md'), 'utf8')).includes('status: completed') && (await readFile(join(features, 'patch.md'), 'utf8')).includes('status: review'); });
  const before = await api('/api/features'); assert.equal(before.error, null); assert.equal(before.errors.length, 0);
  const chat = front(await readFile(join(features, 'chat.md'), 'utf8')), patch = front(await readFile(join(features, 'patch.md'), 'utf8'));
  assert.equal(chat.status, 'completed'); assert.equal(patch.status, 'review'); assert.match(await readFile(join(features, patch.werk.patch), 'utf8'), /\+changed/); assert.equal(await readFile(join(cwd, 'approved.txt'), 'utf8'), 'original\n');
  await cli(entry, cwd, 'stop'); running = false; await assert.rejects(readFile(join(features, '_worker.lock')), { code: 'ENOENT' });
  const relocated = await cli(entry, cwd, 'feature', 'folder', 'set', '--path', 'requests/features');
  features = relocated.directory;
  assert.equal((await cli(entry, cwd, 'feature', 'folder', 'get')).path, 'requests/features');
  assert.equal(front(await readFile(join(features, 'chat.md'), 'utf8')).id, chat.id);
  started = await cli(entry, cwd, 'start', '--port', '0'); running = true;
  await eventually(async () => (await api('/api/features')).records.length === 2);
  assert.deepEqual((await api('/api/features')).records.map(r => r.taskId).sort(), before.records.map(r => r.taskId).sort());
  assert.deepEqual((await api('/api/features')).records.map(r => r.feature.key).sort(), before.records.map(r => r.feature.key).sort());
  assert.equal((await api('/api/sessions')).records.length, 3);
  assert.equal((await cli(entry, cwd, 'feature', 'list')).records.length, 2);
  await cli(entry, cwd, 'stop'); running = false;
});

test('generated private question, task and gate ignores preserve operator rules and remain idempotent on repeat init', async t => {
  const cwd = await project(t);
  const setup = await initializeWorker(resolve('bin/apps/worker'), { 'project-dir': cwd, 'features-dir': 'requests/features' });
  assert.match(setup.intake.setup, /shared setup/); assert.match(setup.next, /local provider explicitly/);
  const ignorePath = join(setup.featuresDirectory, '.gitignore');
  assert.match(await readFile(ignorePath, 'utf8'), /^_questions\/$/m);
  assert.match(await readFile(ignorePath, 'utf8'), /^_gates\/$/m);
  await writeFile(ignorePath, '# Operator-owned ignore rules\n_results/\ncustom-private.txt\n');
  await initializeWorker(setup.application, { 'project-dir': cwd });
  const first = await readFile(ignorePath, 'utf8');
  assert.match(first, /^custom-private\.txt$/m); assert.match(first, /^_results\/$/m); assert.match(first, /^_questions\/$/m); assert.match(first, /^_gates\/$/m);
  assert.match(first, /^_tasks\/$/m); assert.equal(first.split('\n').filter(line => line === '_tasks/').length, 1);
  assert.equal(first.split('\n').filter(line => line === '_gates/').length, 1);
  await initializeWorker(setup.application, { 'project-dir': cwd });
  assert.equal(await readFile(ignorePath, 'utf8'), first);
});
test('init places workflow files under --workflow-dir, skips the root package with --no-npm and keeps the project root clean', async t => {
  const cwd = await project(t), result = await cli(installer, cwd, 'init', '--workflow-dir', 'Vault/Workflows', '--no-npm');
  assert.deepEqual(result.npm, { skipped: true });
  await assert.rejects(readFile(join(cwd, 'package.json')), { code: 'ENOENT' });
  const workflow = JSON.parse(await readFile(join(cwd, '.werk/feature-workflow.json'), 'utf8'));
  assert.deepEqual({ base: workflow.base, reviewDirectory: workflow.reviewDirectory, tasksDirectory: workflow.tasksDirectory, readyCheck: workflow.readyCheck, doneCheck: workflow.doneCheck, requestsDirectory: workflow.requestsDirectory },
    { base: 'Vault/Workflows/Feature Requests.base', reviewDirectory: 'Vault/Workflows/reviews', tasksDirectory: 'Vault/Workflows/tasks', readyCheck: 'Vault/Workflows/checks/fr-ready-check.json', doneCheck: 'Vault/Workflows/checks/fr-done-check.json', requestsDirectory: 'features' });
  for (const file of ['Feature Requests.base', 'checks/fr-ready-check.json', 'checks/fr-done-check.json']) assert.ok(await readFile(join(cwd, 'Vault/Workflows', file), 'utf8'));
  const base = parse(await readFile(join(cwd, 'Vault/Workflows/Feature Requests.base'), 'utf8'));
  assert.deepEqual(base.views[1].filters.and[0], 'file.folder == "Vault/Workflows/tasks"');
  for (const file of ['Feature Requests.base', 'fr-ready-check.json', 'fr-done-check.json']) await assert.rejects(readFile(join(cwd, file)), { code: 'ENOENT' });
  assert.deepEqual(result.authoring.warnings, []);
});
test('init without layout options keeps the root defaults and reports the project package', async t => {
  const cwd = await project(t), result = await cli(installer, cwd, 'init');
  assert.equal(result.npm.created, true);
  assert.ok(await readFile(join(cwd, 'Feature Requests.base'), 'utf8')); assert.ok(await readFile(join(cwd, 'fr-ready-check.json'), 'utf8'));
  assert.equal(JSON.parse(await readFile(join(cwd, '.werk/feature-workflow.json'), 'utf8')).reviewDirectory, 'feature-reviews');
});
test('an existing workflow wins over a differing --workflow-dir and the warning names both locations', async t => {
  const cwd = await project(t); await cli(installer, cwd, 'init', '--no-npm');
  const again = await cli(join(cwd, 'bin/apps/worker/cli.mjs'), cwd, 'init', '--workflow-dir', 'Vault/Workflows', '--no-npm');
  assert.equal(again.authoring.warnings.length, 1); assert.equal(again.authoring.warnings[0].code, 'workflow_directory_mismatch');
  assert.match(again.authoring.warnings[0].message, /--workflow-dir Vault\/Workflows/); assert.match(again.authoring.warnings[0].message, /Feature Requests\.base/);
  assert.equal(JSON.parse(await readFile(join(cwd, '.werk/feature-workflow.json'), 'utf8')).base, 'Feature Requests.base');
  await assert.rejects(readFile(join(cwd, 'Vault/Workflows/Feature Requests.base')), { code: 'ENOENT' });
  const same = await cli(join(cwd, 'bin/apps/worker/cli.mjs'), cwd, 'feature', 'setup');
  assert.deepEqual(same.warnings, []);
});
test('feature setup honors --workflow-dir and rejects folders outside the project', async t => {
  const cwd = await project(t);
  assert.ok((await cli(installer, cwd, 'schema')).commands['feature setup'].options.includes('workflow-dir'), 'schema agrees with help and validation');
  for (const bad of ['../outside', '.', '.werk/flow']) await assert.rejects(cli(installer, cwd, 'feature', 'setup', '--project-dir', cwd, '--workflow-dir', bad), /--workflow-dir/);
  await assert.rejects(cli(installer, cwd, 'init', '--workflow-dir', 'features/flow'), /--workflow-dir features\/flow cannot be used/);
  const result = await cli(installer, cwd, 'feature', 'setup', '--project-dir', cwd, '--workflow-dir', 'Vault/Flow');
  assert.equal(result.workflow.base, 'Vault/Flow/Feature Requests.base');
  assert.ok(await readFile(join(cwd, 'Vault/Flow/checks/fr-done-check.json'), 'utf8'));
  await assert.rejects(readFile(join(cwd, 'Feature Requests.base')), { code: 'ENOENT' });
});
