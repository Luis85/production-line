import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, rm, readFile, writeFile, realpath } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { workerNpmScripts, seedWorkerPackage } from '../../scripts/runtime/portable/npm-package.mjs';
import { commands } from '../../scripts/runtime/portable/commands.mjs';

const exec = promisify(execFile), installer = resolve('bin/apps/worker/cli.mjs');
async function project(t, cleanup = true) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'werk npm project ')));
  if (cleanup) t.after(() => rm(path, { recursive: true, force: true })); return path;
}
async function invoke(cwd, file, args) {
  try {
    const result = await exec(process.execPath, [file, ...args], { cwd, timeout: 45000, maxBuffer: 1048576, env: { ...process.env, npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' } });
    return { code: 0, ...result };
  } catch (error) { if (!Number.isInteger(error.code)) throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}
async function cli(cwd, entry, ...args) {
  const result = await invoke(cwd, entry, args); assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout);
}
async function npmPath() {
  for (const path of [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean)) {
    try { await access(path); return path; } catch {}
  }
  throw Error('npm is required to verify its optional script entrypoints.');
}
async function npm(cwd, prefix, name, args = [], expected = 0) {
  const result = await invoke(cwd, await npmPath(), ['--silent', '--prefix', prefix, 'run', name, '--', ...args]);
  assert.equal(result.code, expected, result.stderr || result.stdout); return JSON.parse(result.stdout);
}

test('worker npm scripts expose supported commands without install or build hooks', async () => {
  const manifest = JSON.parse(await readFile('bin/apps/worker/package.json', 'utf8'));
  assert.deepEqual(manifest.scripts, workerNpmScripts());
  const catalog = commands('worker');
  for (const command of Object.keys(catalog)) assert.ok(manifest.scripts[command.replaceAll(' ', ':')], command);
  for (const name of ['worker', 'start', 'run', 'status', 'stop', 'schema', 'feature:setup', 'feature:author:create', 'feature:author:validate', 'feature:author:ready']) assert.ok(manifest.scripts[name], name);
  for (const name of ['install', 'preinstall', 'postinstall', 'prepare', 'build']) assert.equal(manifest.scripts[name], undefined);
  assert.equal(manifest.dependencies, undefined); assert.equal(manifest.devDependencies, undefined);
});

test('root npm manifest is create-only and does not change project module semantics or custom scripts', async t => {
  const cwd = await project(t), path = join(cwd, 'package.json');
  assert.equal((await seedWorkerPackage(cwd)).created, true);
  const initial = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(initial.private, true); assert.equal(initial.type, undefined); assert.equal(initial.dependencies, undefined);
  assert.equal(initial.scripts['worker:status'], 'node bin/apps/worker/cli.mjs status');
  const customized = '{\n  "name": "existing-project", "type":"commonjs",\n  "scripts": {"worker":"node my-worker.js","test":"node custom-test.cjs"}\n}\n';
  await writeFile(path, customized);
  assert.equal((await seedWorkerPackage(cwd)).created, false);
  assert.equal(await readFile(path, 'utf8'), customized);
});

test('installed npm commands forward arguments and share the caller project state without npm install', { timeout: 120000 }, async t => {
  const cwd = await project(t, false), entry = join(cwd, 'bin/apps/worker/cli.mjs'), state = 'state with spaces';
  t.after(async () => { try { await cli(cwd, entry, 'stop', '--state-dir', state).catch(() => {}); } finally { await rm(cwd, { recursive: true, force: true }); } });
  const installed = await cli(cwd, installer, 'init');
  const app = installed.application;
  assert.equal(installed.npm.created, true);
  assert.equal((await npm(cwd, app, 'worker', ['schema'])).application, 'worker');
  assert.equal((await npm(cwd, app, 'status', ['--state-dir', state])).stateDirectory, join(cwd, state));
  assert.equal((await npm(app, app, 'status')).stateDirectory, join(cwd, '.werk/worker'), 'running npm inside the app finds its initialized project');
  const started = await npm(cwd, app, 'start', ['--port', '0', '--state-dir', state]);
  assert.equal(started.state, 'running'); assert.equal(started.stateDirectory, join(cwd, state));
  const status = await npm(cwd, cwd, 'worker:status', ['--state-dir', state]);
  assert.equal(status.runId, started.runId); assert.equal(status.url, started.url);
  assert.equal((await npm(app, app, 'stop', ['--state-dir', state])).state, 'stopped');
  assert.equal((await npm(cwd, cwd, 'worker', ['status', '--state-dir', state])).state, 'stopped');
  await assert.rejects(access(join(cwd, 'node_modules')), { code: 'ENOENT' });
  await assert.rejects(access(join(cwd, 'package-lock.json')), { code: 'ENOENT' });
});

test('init preserves an existing npm project exactly while installed app scripts stay available', async t => {
  const cwd = await project(t), manifest = '{"private":true,"type":"commonjs","scripts":{"worker":"node own-worker.cjs","test":"node test.cjs"}}\n';
  await writeFile(join(cwd, 'package.json'), manifest);
  const installed = await cli(cwd, installer, 'init');
  assert.equal(installed.npm.created, false);
  assert.equal(await readFile(join(cwd, 'package.json'), 'utf8'), manifest);
  assert.equal((await npm(cwd, installed.application, 'status')).stateDirectory, join(cwd, '.werk/worker'));
  await cli(cwd, join(installed.application, 'cli.mjs'), 'init');
  assert.equal(await readFile(join(cwd, 'package.json'), 'utf8'), manifest);
});

test('npm authoring aliases install and operate offline from an unrelated project with exact forwarded arguments', async t => {
  const cwd = await project(t), app = dirname(installer), folder = 'team requests';
  const setup = await npm(cwd, app, 'feature:setup', ['--features-dir', folder]);
  assert.equal(setup.project, cwd); assert.equal(setup.workflow.requestsDirectory, folder);
  await assert.rejects(access(join(cwd, 'bin')), { code: 'ENOENT' });
  await assert.rejects(access(join(cwd, '.werk/worker')), { code: 'ENOENT' });
  const title = 'Unicode Werk – shared request';
  const created = await npm(cwd, app, 'feature:author:create', ['--name', 'request.md', '--title', title]);
  assert.equal(created.path, folder + '/request.md'); assert.equal(created.status, 'draft');
  const path = join(cwd, created.path), draft = await readFile(path, 'utf8');
  assert.ok(draft.includes(title)); assert.match(draft, /templateId: feature-request-v1/);
  const invalid = await npm(cwd, app, 'feature:author:validate', ['--file', created.path], 2);
  assert.equal(invalid.valid, false); assert.equal(invalid.revision, created.revision); assert.ok(invalid.errors.length);
  const blocked = await npm(cwd, app, 'feature:author:ready', ['--file', created.path, '--if-match', created.revision], 2);
  assert.equal(blocked.status, 'draft'); assert.equal(await readFile(path, 'utf8'), draft);
  await assert.rejects(access(join(cwd, 'node_modules')), { code: 'ENOENT' });
  await assert.rejects(access(join(cwd, '.werk/worker')), { code: 'ENOENT' });
});
