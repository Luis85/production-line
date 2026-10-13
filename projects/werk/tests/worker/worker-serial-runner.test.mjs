import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configuration } from '../../src/worker/dist/worker/config.js';
import { runWorker } from '../../src/worker/dist/worker/runner.js';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const end = Date.now() + 12000; while (Date.now() < end) { if (await check()) return; await delay(40); } throw Error('Worker condition timed out'); }

test('configuration and direct runner reject multiple execution slots before owning state', async t => {
  await assert.rejects(configuration({ parallel: '2' }), /parallel must be 1/);
  await assert.rejects(configuration({}, { scheduler: { maxParallel: 2 } }), /parallel must be 1/);
  await assert.rejects(configuration({}, { profiles: [{ id: 'two', provider: 'codex', mode: 'mock', maxParallel: 2 }] }), /one execution slot/);
  const directory = await mkdtemp(join(tmpdir(), 'werk-serial-config-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const config = await configuration({});
  for (const override of [{ policy: { ...config.policy, maxParallel: 2 } }, { profiles: [{ ...config.profiles[0], maxParallel: 2 }] }]) {
    await assert.rejects(runWorker({ ...config, ...override, stateDir: directory, enrollmentToken: '', statusHost: '127.0.0.1', statusPort: 0 }, new AbortController().signal), /exactly one execution slot/);
    await assert.rejects(lstat(join(directory, 'worker.lock')), { code: 'ENOENT' });
  }
  assert.equal(config.policy.maxParallel, 1); assert.ok(config.profiles.every(profile => profile.maxParallel === 1));
});

test('remote execution shares the session gate, retains waiting leases while paused, and records task evidence', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-serial-runner-')), stop = new AbortController();
  const config = await configuration({ profiles: 'codex', 'poll-ms': '100', 'mock-ms': '1', 'retain-acknowledged-pairs': '0' });
  let workspace, releaseChat, run, completed = false, executions = 0, renewals = 0;
  const originalInit = WorkerWorkspace.prototype.init;
  WorkerWorkspace.prototype.init = async function () { await originalInit.call(this); workspace = this; releaseChat = await this.executor.acquire('default', stop.signal); };
  t.after(async () => { stop.abort(); releaseChat?.(); await run; WorkerWorkspace.prototype.init = originalInit; await rm(directory, { recursive: true, force: true }); });
  const task = { id: 'serial-task', project: 'alpha', title: 'Keep the actual request', criteria: ['Record the outcome'], wikilinks: [], provider: 'codex', priority: 1, status: 'running', attempt: 1, workerId: 'worker-one', lease: 'serial-lease', expiresAt: Date.now() + 1500, createdAt: Date.now(), profile: config.profiles[0].id };
  let claimed = false;
  const client = { async currentAssignments() { return claimed && !completed ? [task] : []; }, async claim() { if (claimed) return null; claimed = true; return task; }, async heartbeat() { renewals++; task.expiresAt = Date.now() + 1500; return task; }, async publishSnapshot() {}, async complete() { completed = true; }, async abandon() { completed = true; } };
  const gateway = { async register(profiles, policy) { assert.equal(policy.maxParallel, 1); return { id: 'worker-one', token: 'fixture-token', project: 'alpha' }; }, connect() { return client; } };
  const adapter = { mode: 'mock', async run() { executions++; assert.equal(workspace.executor.current, 'remote-serial-task'); return { kind: 'simulated', summary: 'Actual simulation' }; } };
  run = runWorker({ ...config, stateDir: directory, url: 'http://orchestrator.invalid', enrollmentToken: 'fixture-enrollment', statusHost: '127.0.0.1', statusPort: 0 }, stop.signal, { gateway, adapter });
  await until(() => workspace && claimed); await until(() => renewals >= 3); assert.equal(executions, 0, 'another task owns the shared execution slot');
  await workspace.settings.update({ board: { paused: true } }); releaseChat(); releaseChat = undefined;
  const before = renewals; await until(() => renewals > before); assert.equal(executions, 0, 'paused remote task retains its lease without starting');
  await workspace.settings.update({ board: { paused: false } });
  await until(() => completed && workspace.sessions.view().records.find(record => record.id === 'remote-serial-task')?.status === 'completed');
  assert.equal(executions, 1);
  const conversation = JSON.parse(await readFile(join(directory, 'sessions/remote-serial-task/conversation.json'), 'utf8'));
  assert.match(conversation.messages[0].text, /Keep the actual request/); assert.match(conversation.messages[0].text, /Record the outcome/);
  assert.match(conversation.messages[1].text, /simulated/); assert.match(conversation.messages[1].text, /not_evaluated/);
  assert.ok(!conversation.messages[0].text.includes('serial-lease'), 'lease authority is excluded from transcript');
  await assert.rejects(lstat(join(directory, 'snapshots/serial-lease')), { code: 'ENOENT' });
  stop.abort(); await run;
});


test('failed initial lease renewal cancels the prepared session when the assignment disappears', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-rejected-assignment-')), stop = new AbortController();
  const config = await configuration({ profiles: 'codex', 'poll-ms': '100' });
  let workspace, run, claimed = false, polls = 0, executions = 0, heartbeats = 0;
  const originalInit = WorkerWorkspace.prototype.init;
  WorkerWorkspace.prototype.init = async function () { await originalInit.call(this); workspace = this; };
  t.after(async () => { stop.abort(); await run; WorkerWorkspace.prototype.init = originalInit; await rm(directory, { recursive: true, force: true }); });
  const task = { id: 'withdrawn-task', project: 'alpha', title: 'Withdrawn before execution', criteria: ['Never execute'], wikilinks: [], provider: 'codex', priority: 1, status: 'running', attempt: 1, workerId: 'worker-one', lease: 'withdrawn-lease', createdAt: Date.now(), profile: config.profiles[0].id };
  const client = {
    async currentAssignments() { polls++; return []; },
    async claim() { if (claimed) return null; claimed = true; return { ...task, expiresAt: Date.now() + 60000 }; },
    async heartbeat() { heartbeats++; throw Error('Assignment no longer owned'); },
    async publishSnapshot() { throw Error('No attempt evidence should exist'); },
    async complete() { throw Error('No execution should complete'); }, async abandon() {},
  };
  const gateway = { async register() { return { id: 'worker-one', token: 'fixture-token', project: 'alpha' }; }, connect() { return client; } };
  const adapter = { mode: 'mock', async run() { executions++; return { kind: 'simulated', summary: 'Unexpected' }; } };
  run = runWorker({ ...config, stateDir: directory, url: 'http://orchestrator.invalid', enrollmentToken: 'fixture-enrollment', statusHost: '127.0.0.1', statusPort: 0 }, stop.signal, { gateway, adapter });
  await until(() => workspace?.sessions.view().records.find(record => record.id === 'remote-withdrawn-task')?.status === 'cancelled');
  const acceptedAtPoll = polls; await until(() => polls > acceptedAtPoll);
  assert.equal(heartbeats, 1); assert.equal(executions, 0);
  assert.equal(workspace.executor.current, null);
  assert.equal(workspace.sessions.view().records.find(record => record.id === 'remote-withdrawn-task').status, 'cancelled');
  const saved = JSON.parse(await readFile(join(directory, 'sessions.json'), 'utf8'));
  assert.equal(saved.records.find(record => record.id === 'remote-withdrawn-task').taskState, 'cancelled');
  const conversation = JSON.parse(await readFile(join(directory, 'sessions/remote-withdrawn-task/conversation.json'), 'utf8'));
  assert.equal(conversation.messages.length, 2); assert.match(conversation.messages[0].text, /Withdrawn before execution/);
  assert.match(conversation.messages[1].text, /No execution started/); assert.equal(conversation.messages[1].state, 'error');
  await assert.rejects(lstat(join(directory, 'snapshots/withdrawn-lease')), { code: 'ENOENT' });
  stop.abort(); await run;
});
