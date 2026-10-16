import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, stat, chmod, symlink, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { stateDirectory } from '../../scripts/runtime/portable/lifecycle.mjs';
const project = fileURLToPath(new URL('../../', import.meta.url));
function invoke(file, cwd, args, body, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, env: { ...process.env, ...environment }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', part => stdout += part); child.stderr.on('data', part => stderr += part);
    child.once('error', reject);
    const timeout = setTimeout(() => { child.kill(); reject(Error('CLI deadline: ' + args[0])); }, 40000);
    child.once('close', code => { clearTimeout(timeout); let data; try { data = JSON.parse(stdout); } catch {} resolve({ code, stdout, stderr, data }); });
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function until(operation, predicate, timeout = 18000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await operation(); if (predicate(value)) return value; await delay(150); }
  throw Error('Expected state did not arrive');
}
test('state separation resolves directory aliases and absent descendants', async t => {
  const root = await mkdtemp(join(tmpdir(), 'werk-path-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'app'), alias = join(root, 'alias'); await mkdir(app);
  try { await symlink(app, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Junction creation unavailable'); throw error; }
  await assert.rejects(stateDirectory('worker', await realpath(app), join(alias, 'new', 'state')), /outside the copied app/);
  await assert.rejects(stateDirectory('worker', alias, join(app, 'new', 'state')), /outside the copied app/);
  assert.equal(await stateDirectory('worker', app, join(root, 'separate-state')), join(root, 'separate-state'));
});
test('copied apps operate independently with agent tasks, durable state and later composition', { timeout: 120000 }, async t => {
  const outer = await mkdtemp(join(tmpdir(), 'werk copied apps '));
  const entries = {};
  // Each folder is in a separate unrelated CommonJS project with no source or npm install.
  for (const kind of ['factory', 'orchestrator', 'worker']) {
    const cwd = join(outer, kind + ' project'), app = join(cwd, 'bin/apps', kind);
    await mkdir(cwd, { recursive: true }); await writeFile(join(cwd, 'package.json'), '{"type":"commonjs"}');
    await cp(join(project, 'bin/apps', kind), app, { recursive: true });
    entries[kind] = { cwd, app, cli: join(app, 'cli.mjs') };
  }
  const invokeApp = async (kind, command, options = [], body, environment) => {
    const { cwd, cli } = entries[kind]; const result = await invoke(cli, cwd, [...command.split(' '), ...options, ...(body === undefined ? [] : ['--file', '-'])], body, environment);
    return result;
  };
  const ok = async (...args) => { const result = await invokeApp(...args); assert.equal(result.code, 0, result.stderr); assert.ok(result.data); return result.data; };
  t.after(async () => {
    for (const kind of ['worker', 'factory', 'orchestrator']) await invokeApp(kind, 'stop').catch(() => {});
    await invokeApp('worker', 'stop', ['--state-dir', '.werk/second']).catch(() => {});
    await rm(outer, { recursive: true, force: true });
  });
  for (const kind of Object.keys(entries)) {
    const schema = await ok(kind, 'schema'); assert.equal(schema.application, kind); assert.ok(schema.commands.monitoring);
    assert.equal((await ok(kind, 'status')).state, 'stopped');
  }
  const first = await ok('worker', 'start', ['--port', '0', '--mock-ms', '20', '--poll-ms', '100']);
  const second = await ok('worker', 'start', ['--port', '0', '--state-dir', '.werk/second']);
  assert.notEqual(first.url, second.url); assert.notEqual(first.runId, second.runId);
  assert.equal((await invokeApp('worker', 'start', ['--port', '0'])).code, 2);
  assert.equal((await invokeApp('worker', 'start', ['--state-dir', entries.worker.app + '/state'])).code, 2);
  assert.equal((await invokeApp('worker', 'settings get', ['--url', first.url])).code, 2);
  const page = await fetch(first.url); assert.equal(page.status, 200); assert.match(await page.text(), /<div id="app"/);
  const token = (await readFile(first.credentialsFile, 'utf8')).trim();
  assert.ok(!JSON.stringify(first).includes(token));
  if (process.platform !== 'win32') assert.equal((await stat(first.credentialsFile)).mode & 0o077, 0);
  assert.equal((await fetch(first.url + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  // Windows supports API providers; this paused/cancelled fixture must never call one.
  const queuedProvider = process.platform === 'win32' ? { id: 'openai-api', model: 'test-do-not-execute', apiKey: 'fixture-not-a-real-key' } : { id: 'codex-cli', executable: process.execPath };
  await ok('worker', 'settings set', [], { provider: queuedProvider, board: { paused: true, queueCapacity: 4 } });
  const definitionInput = { name: 'Project reviewer', yaml: 'version: "15"\nagents:\n  root:\n    model: openai/fixture-model\n    instruction: Review acceptance criteria before proposing work.\n' };
  const preview = await ok('worker', 'definition preview', [], { yaml: definitionInput.yaml });
  assert.equal(preview.agents[0].name, 'root');
  const imported = await ok('worker', 'definition import', [], definitionInput);
  const definition = imported.definitions.find(item => item.name === definitionInput.name);
  assert.ok(definition?.id); assert.match(definition.digest, /^[a-f0-9]{64}$/);
  assert.equal((await ok('worker', 'definition list')).definitions.length, 1);
  assert.equal((await ok('worker', 'definition ref', ['--id', definition.id, '--ref', 'project-reviewer'])).definitions[0].ref, 'project-reviewer');
  assert.equal((await invokeApp('worker', 'definition ref', ['--id', definition.id, '--ref', 'Not Valid'])).code, 2);
  assert.equal((await ok('worker', 'provider check', ['--id', 'openai-api'])).authentication, 'not-verified');
  const task = { id: 'ci-task-1', title: 'Agent task', provider: queuedProvider.id, definitionId: definition.id, agent: 'root', message: 'Fixture instruction; do not execute.' };
  const created = await ok('worker', 'task create', [], task); assert.equal(created.session.id, task.id); assert.equal(created.session.status, 'queued');
  assert.equal((await ok('worker', 'task create', [], task)).chat.messages.length, 2);
  assert.equal((await invokeApp('worker', 'task create', [], { ...task, message: 'different input' })).code, 2);
  assert.equal((await ok('worker', 'task list')).selected, 'default', 'agent must not change UI selection');
  await ok('worker', 'task create', [], { ...task, id: 'ci-task-2' });
  const queue = await ok('worker', 'task list'); assert.equal(queue.execution.maxParallel, 1); assert.equal(queue.execution.currentSessionId, null); assert.equal(queue.records.filter(row => row.status === 'queued').length, 2);
  const { definitionId: _localId, ...portable } = task, byRef = await ok('worker', 'task create', [], { ...portable, id: 'ci-task-ref', definitionRef: 'project-reviewer' });
  assert.equal(byRef.session.definition.definitionId, definition.id); await ok('worker', 'task cancel', ['--id', 'ci-task-ref']);
  await ok('worker', 'task cancel', ['--id', task.id]);
  await ok('worker', 'task send', ['--id', task.id], { message: 'Same-session follow-up.' });
  assert.equal((await ok('worker', 'task get', ['--id', task.id])).chat.messages.length, 4);
  const identity = (await ok('worker', 'environment')).status.machineId;
  const isolated = await ok('worker', 'task list', ['--state-dir', '.werk/second']); assert.equal(isolated.records.length, 1);
  const stopped = await ok('worker', 'stop'); assert.equal(stopped.state, 'stopped');
  const restarted = await ok('worker', 'start', ['--port', '0', '--mock-ms', '20', '--poll-ms', '100']);
  assert.equal((await readFile(restarted.credentialsFile, 'utf8')).trim(), token);
  assert.equal((await ok('worker', 'environment')).status.machineId, identity);
  const retained = await ok('worker', 'task get', ['--id', task.id]); assert.equal(retained.chat.messages.length, 4); assert.equal(retained.session.status, 'cancelled');
  assert.equal((await ok('worker', 'task list')).records.some(record => record.busy), false, 'restart cancelled all pending model calls');
  assert.equal(retained.session.definition.digest, definition.digest);
  assert.equal((await ok('worker', 'definition list')).definitions[0].digest, definition.digest);
  // Protocol fixture only: no provider credentials or live LLM calls.
  if (process.platform === 'linux') {
    const executable = join(entries.worker.cwd, 'model-fixture'), audit = join(outer, 'model-events.jsonl');
    await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');let input='';process.stdin.on('data',p=>input+=p);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(audit)},JSON.stringify({phase:'start',pid:process.pid})+'\\n');setTimeout(()=>{const reply=input.includes('Approved file snapshots:')?JSON.stringify({summary:'Fixture patch; tests not run',files:[{path:'acceptance.txt',content:'after\\n'}]}):'Protocol fixture response';fs.appendFileSync(${JSON.stringify(audit)},JSON.stringify({phase:'end',pid:process.pid})+'\\n');console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:reply}}));},400);});\n`);
    await chmod(executable, 0o700);
    await ok('worker', 'settings set', [], { provider: { id: 'codex-cli', executable } });
    await ok('worker', 'task create', [], { ...task, id: 'fixture-1' });
    await ok('worker', 'task create', [], { ...task, id: 'fixture-2' });
    await ok('worker', 'settings set', [], { board: { paused: false } });
    await until(() => ok('worker', 'task get', ['--id', 'fixture-2']), value => !value.chat.busy);
    assert.equal((await ok('worker', 'task get', ['--id', 'fixture-1'])).chat.messages.at(-1).text, 'Protocol fixture response');
    const events = (await readFile(audit, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map(event => event.phase), ['start', 'end', 'start', 'end']);
    await ok('worker', 'session action', [], { action: 'rename', id: 'fixture-1', title: 'Renamed by the user' });
    const replay = await ok('worker', 'task create', [], { ...task, id: 'fixture-1' });
    assert.equal(replay.session.title, 'Renamed by the user'); assert.equal(replay.chat.messages.length, 2);
    const repository = join(entries.worker.cwd, 'project files'); await mkdir(repository);
    await writeFile(join(repository, 'acceptance.txt'), 'before\n');
    const files = await ok('worker', 'file-task create', [], { title: 'Explicit file task', instruction: 'Change before to after', repository, provider: 'codex-cli', paths: ['acceptance.txt'] });
    const fileId = files.tasks.at(-1).id;
    const result = await until(() => ok('worker', 'file-task get', ['--id', fileId]), value => value.status === 'review' || value.status === 'failed');
    assert.equal(result.status, 'review'); assert.match(result.patch, /\+after/);
    assert.equal(await readFile(join(repository, 'acceptance.txt'), 'utf8'), 'before\n');
  }
  // Compose only after demonstrating two independent workers.
  const line = await ok('orchestrator', 'start', ['--port', '0', '--project', 'demo']);
  const credentials = JSON.parse(await readFile(line.credentialsFile, 'utf8'));
  await ok('worker', 'settings set', [], { connection: { enabled: true, url: line.url, enrollmentToken: credentials.enrollmentToken }, board: { paused: false } });
  await until(() => ok('orchestrator', 'workers list'), value => value.workers?.length > 0 || value.items?.length > 0);
  await ok('factory', 'start', ['--port', '0'], undefined, { WERK_LINE_ALPHA_TOKEN: credentials.adminToken });
  await ok('factory', 'factory create', ['--key', 'factory-main'], { id: 'main', name: 'Project factory', parentId: null });
  await ok('factory', 'line create', ['--key', 'line-alpha'], { id: 'alpha', name: 'Alpha', factoryId: 'main', orchestratorUrl: line.url, webviewUrl: line.url, tokenEnv: 'WERK_LINE_ALPHA_TOKEN' });
  await ok('factory', 'routing set', ['--id', 'main'], { mode: 'auto', lineId: null, paused: false });
  const intake = { factoryId: 'main', task: { project: 'demo', title: 'CLI integration fixture', criteria: ['Record simulation evidence'], wikilinks: [], provider: 'codex' } };
  const accepted = await ok('factory', 'intake create', ['--key', 'intake-one'], intake);
  assert.equal((await ok('factory', 'intake create', ['--key', 'intake-one'], intake)).id, accepted.id);
  await until(() => ok('factory', 'intake list'), value => value.tasks.some(item => item.status === 'delivered'));
  const tasks = await until(() => ok('orchestrator', 'task list'), value => (value.tasks ?? value.items ?? []).some(item => item.status === 'simulated'));
  assert.ok(JSON.stringify(tasks).includes('CLI integration fixture'));
  await ok('worker', 'stop'); await ok('worker', 'stop');
  assert.equal((await ok('worker', 'status', ['--state-dir', '.werk/second'])).state, 'running');
});
