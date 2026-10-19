import { delegationTool } from '../../src/worker/dist/worker/infrastructure/delegation-tools.js';
import test from 'node:test';
import { createProcessObservation } from '../../src/worker/dist/worker/infrastructure/process-observation.js';
import { runProcess } from '../../src/worker/dist/shared/process/launcher.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { WorkerRunJournal } from '../../src/worker/dist/worker/infrastructure/journal/local-runs.js';
import { WorkerConsumptionJournal } from '../../src/worker/dist/worker/infrastructure/journal/consumption.js';
import { WorkerConsumption, defaultConsumptionPolicy } from '../../src/worker/dist/worker/application/consumption.js';
import { unknownUsage } from '../../src/worker/dist/worker/application/run-evidence.js';
import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';
import { ToolAccessError } from '../../src/worker/dist/worker/application/tool-runtime.js';
import { createDelegationChildRunner } from '../../src/worker/dist/worker/infrastructure/delegation-child.js';
import { FileModelSessionStore } from '../../src/worker/dist/worker/infrastructure/model-session-store.js';

/** @typedef {import('../../src/worker/infrastructure/delegation-child.ts').DelegationChildOptions} ChildOptions */
/** @typedef {import('../../src/worker/application/model-contract.ts').StructuredModel} StructuredModel */
/** @param {number} [inputTokens] @param {number} [outputTokens] */
const usage = (inputTokens = 20, outputTokens = 10) => ({ ...unknownUsage(), inputTokens, outputTokens, source: /** @type {const} */ ('provider_reported'), reason: null });
/** @returns {import('../../src/worker/application/tool-runtime.ts').ToolRuntime} */
function tools() {
  return {
    manifest: { revision: 1, tools: [{ name: 'werk_file_read', description: 'Read approved files.', inputSchema: { type: 'object' } }] },
    limits: { maxCalls: 8, maxRuntimeMs: 10000, commandTimeoutMs: 1000 },
    assertAvailable(signal) { signal.throwIfAborted(); },
    async call() { return { content: [{ type: 'text', text: 'Fixture content' }] }; },
    async close() {},
  };
}
/** @param {StructuredModel['execute']} execute @returns {NonNullable<ChildOptions['model']>} */
function factory(execute) {
  return () => ({ capabilities: { ...modelCapabilities, continuation: 'provider_session', nativeResume: true }, async reply() { throw Error('Structured adapter expected.'); }, execute });
}
/** @param {import('node:test').TestContext} t @param {NonNullable<ChildOptions['model']>} [model] */
async function fixture(t, model = factory(async (_request, _signal, observe, control) => {
  control?.beforeCall(); observe?.(usage()); return { type: 'completed', text: 'Private child result.' };
})) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-delegation-child-'));
  const runs = new WorkerRunJournal(directory); await runs.init();
  const ledger = new WorkerConsumptionJournal(directory);
  const consumption = new WorkerConsumption(ledger, () => ({ ...defaultConsumptionPolicy(), enabled: true, allowance: 2000, workerPercent: 100, perRunReservation: 100 }));
  await consumption.init();
  t.after(async () => { consumption.close(); runs.close(); await rm(directory, { recursive: true, force: true }); });
  const parent = await runs.begin({ sessionId: 'parent-session', taskId: 'shared-task', requestId: 'shared-request', kind: 'local', title: 'Same Feature Request', provider: 'claude-cli', model: 'fixture-model' });
  await runs.start(parent.id);
  /** @type {ChildOptions} */
  const options = {
    connection: { id: 'claude-cli', executable: '/fixture/claude', model: 'fixture-model', apiKey: '', effort: 'high', instruction: 'Keep the selected execution profile.' },
    directory, featureRequestKey: 'fr-' + 'a'.repeat(64), parentSessionId: parent.sessionId,
    parent: () => runs.latest(parent.sessionId), runs, consumption, model,
  };
  return { directory, runs, ledger, consumption, parent, options, run: createDelegationChildRunner(options) };
}
/** @param {Partial<import('../../src/worker/application/delegation.ts').DelegationChildInput>} [changes] */
const input = (changes = {}) => ({ id: 'research', prompt: 'Private delegated instruction.', tools: tools(), signal: new AbortController().signal, ...changes });

// These are deliberately injected model adapters; native CLI handle behavior is covered by provider tests.
test('children retain one FR/provider/profile and separate native handles and numeric usage without reopening the journal', async t => {
  /** @type {Array<{directory:string, session:NonNullable<import('../../src/worker/infrastructure/provider-tool-session.ts').ProviderOptions['session']>}>} */
  const calls = [];
  /** @type {NonNullable<ChildOptions['model']>} */
  const model = (connection, directory, _transport, options) => {
    assert.ok(options?.session); const session = options.session;
    calls.push({ directory, session });
    return factory(async (request, signal, observe, control) => {
      control?.beforeCall(); assert.equal(signal.aborted, false);
      assert.equal(request.provider.instruction, connection.instruction);
      assert.equal(request.provider.model, connection.model);
      assert.equal(request.provider.effort, 'high');
      assert.deepEqual(request.session, session.binding);
      assert.equal(request.policy.maxToolCalls, 8);
      assert.equal(request.policy.maxRuntimeMs, 10000);
      assert.deepEqual(request.toolManifest, options.tools().manifest);
      const checkpoint = await session.store.load(session.binding);
      assert.equal(checkpoint.revision, 0);
      await session.store.save(session.binding, 0, { status: 'idle', checkpoint: { nativeId: 'child-native-' + calls.length } });
      observe?.(usage(40, 10)); observe?.(usage(20, 5));
      return { type: 'completed', text: 'Private child result.' };
    })(connection, directory);
  };
  const f = await fixture(t, model);
  t.mock.method(f.runs, 'init', () => { throw Error('Must reuse the open parent journal.'); });
  t.mock.method(f.runs, 'open', () => { throw Error('Must not open another run journal.'); });
  const parentAttempt = f.consumption.begin('claude-cli');
  f.consumption.observe(parentAttempt.id, usage(7, 3)); f.runs.observeUsage(f.parent.id, usage(7, 3));
  const first = await f.run(input()), second = await f.run(input({ id: 'review' }));
  assert.notEqual(first.sessionId, second.sessionId);
  assert.notEqual(first.sessionId, f.parent.sessionId);
  assert.deepEqual(first.usage, usage(40, 10));
  assert.equal(f.runs.get(f.parent.id).outcome, 'running');
  assert.equal(f.runs.get(f.parent.id).usage.inputTokens, 7, 'child usage is never added to parent counters');
  assert.equal(f.consumption.status().activeInvocations, 1);
  f.consumption.finish(parentAttempt.id, usage(7, 3));
  await f.runs.finish(f.parent.id, 'completed', usage(7, 3));
  assert.equal(f.consumption.status().measuredTokens, 110);
  assert.equal(f.consumption.status().chargedTokens, 110);
  const rows = f.runs.list().rows;
  assert.equal(rows.length, 3);
  assert.equal(f.runs.analyze().consumption.inputTokens, 87);
  for (const [index, row] of rows.slice(1).entries()) {
    assert.equal(row.parentRunId, f.parent.id); assert.equal(row.parentSessionId, f.parent.sessionId);
    assert.equal(row.delegationId, ['research', 'review'][index]);
    assert.equal(row.taskId, f.parent.taskId); assert.equal(row.requestId, f.parent.requestId);
    assert.equal(row.outcome, 'completed'); assert.equal(row.attempt, 1);
    const call = calls[index];
    assert.equal(call.directory, join(f.directory, 'sessions', row.sessionId));
    assert.equal(call.session.binding.featureRequestKey, f.options.featureRequestKey);
    assert.equal(call.session.binding.generation, 1);
    assert.equal((await call.session.store.load(call.session.binding)).checkpoint.nativeId, 'child-native-' + (index + 1));
  }
  assert.doesNotMatch(JSON.stringify(rows), /Private child result|Private delegated instruction|nativeId|execution profile/);
  const canonical = { ...calls[0].session.binding, logicalSessionId: f.parent.sessionId };
  assert.equal((await new FileModelSessionStore(f.directory).load(canonical)).revision, 0);
});

test('grant revocation at the paid-call boundary releases only the undispatched child reservation', async t => {
  let granted = true, dispatched = 0;
  const runtime = tools(); runtime.assertAvailable = () => { if (!granted) throw new ToolAccessError(); };
  const f = await fixture(t, factory(async (_request, _signal, _observe, control) => {
    granted = false; control?.beforeCall(); dispatched++; return { type: 'completed', text: 'Not accepted.' };
  }));
  await assert.rejects(f.run(input({ tools: runtime })), ToolAccessError);
  assert.equal(dispatched, 0); assert.equal(f.consumption.status().chargedTokens, 0);
  assert.equal(f.consumption.status().activeInvocations, 0); assert.equal(f.consumption.status().uncertainInvocations, 0);
  assert.equal(f.runs.list().rows[1].outcome, 'failed'); assert.equal(f.runs.get(f.parent.id).outcome, 'running');
});

test('parent cancellation waits for adapter cleanup and preserves separate observed child consumption', async t => {
  const controller = new AbortController();
  const entered = Promise.withResolvers(), cleanup = Promise.withResolvers();
  let closed = false, settled = false;
  const f = await fixture(t, factory(async (_request, signal, observe, control) => {
    control?.beforeCall(); observe?.(usage()); entered.resolve(undefined);
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await cleanup.promise; closed = true; signal.throwIfAborted(); return { type: 'completed', text: 'Discarded.' };
  }));
  const pending = f.run(input({ signal: controller.signal }));
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await entered.promise; controller.abort(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(f.consumption.status().activeInvocations, 1);
  cleanup.resolve(undefined); await assert.rejects(pending); assert.equal(closed, true);
  const child = f.runs.list().rows[1];
  assert.equal(child.outcome, 'cancelled'); assert.equal(child.usage.inputTokens, 20);
  assert.equal(f.consumption.status().measuredTokens, 30); assert.equal(f.consumption.status().uncertainInvocations, 1);
  assert.equal(f.runs.get(f.parent.id).outcome, 'running');
});

test('child questions return to their parent and only numeric evidence remains in the shared journal', async t => {
  const result = { type: /** @type {const} */ ('needs_input'), request: { schemaVersion: /** @type {const} */ (1), kind: /** @type {const} */ ('question'), message: 'A private question for the parent.' } };
  const f = await fixture(t, factory(async (_request, _signal, observe, control) => { control?.beforeCall(); observe?.(usage()); return result; }));
  assert.deepEqual((await f.run(input())).result, result);
  assert.equal(f.runs.list().rows[1].outcome, 'waiting_input');
  assert.equal(f.runs.get(f.parent.id).outcome, 'running');
  assert.doesNotMatch(JSON.stringify(f.runs.list()), /private question/);
});

test('invalid or nested lineage, widened tools and a terminal parent fail before provider dispatch', async t => {
  let calls = 0;
  const f = await fixture(t, factory(async () => { calls++; return { type: 'completed', text: 'Never called.' }; }));
  const widened = tools(); widened.manifest.tools.push({ name: 'werk_delegate', description: 'Forbidden recursive delegation.', inputSchema: {} });
  await assert.rejects(f.run(input({ tools: widened })), { code: 'tool_access' });
  await assert.rejects(createDelegationChildRunner({ ...f.options, parentSessionId: 'another-session' })(input()), { code: 'session_conflict' });
  await assert.rejects(createDelegationChildRunner({ ...f.options, connection: { ...f.options.connection, model: 'another-model' } })(input()), { code: 'session_conflict' });
  await assert.rejects(createDelegationChildRunner({ ...f.options, parent: () => ({ ...f.runs.get(f.parent.id), parentRunId: 'nested' }) })(input()), { code: 'conflict' });
  await f.runs.finish(f.parent.id, 'completed', usage());
  await assert.rejects(f.run(input()), { code: 'conflict' });
  assert.equal(calls, 0); assert.equal(f.runs.list().rows.length, 1); assert.equal(f.consumption.status().chargedTokens, 0);
});

test('shared journal rejects incomplete or cross-FR child metadata and recovers unfinished children without replay', async t => {
  const f = await fixture(t);
  const parent = f.runs.get(f.parent.id);
  const metadata = { sessionId: 'delegated-fixture', taskId: parent.taskId, requestId: parent.requestId, kind: parent.kind, title: parent.title, provider: parent.provider, model: parent.model, parentRunId: parent.id, parentSessionId: parent.sessionId, delegationId: 'work' };
  for (const change of [{ parentSessionId: undefined }, { delegationId: undefined }, { sessionId: parent.sessionId }, { taskId: 'another-fr' }, { requestId: 'another-request' }, { provider: 'openai-api' }]) {
    await assert.rejects(f.runs.begin({ ...metadata, ...change }), { code: 'conflict' });
  }
  const child = await f.runs.begin(metadata); await f.runs.start(child.id); f.runs.observeUsage(child.id, usage());
  assert.equal(f.runs.list().rows.length, 2);
  await f.runs.recover();
  assert.equal(f.runs.get(child.id).outcome, 'interrupted'); assert.equal(f.runs.get(child.id).usage.inputTokens, 20);
  assert.equal(f.runs.get(parent.id).outcome, 'interrupted');
  assert.equal(f.runs.list().rows.length, 2, 'recovery never admits a new child or FR');
});


test('overlapping child CPU windows are excluded from aggregates while child consumption stays additive', async t => {
  const f = await fixture(t);
  await f.run(input()); await f.run(input({ id: 'second' }));
  await f.runs.finish(f.parent.id, 'completed', usage(7, 3));
  const rows = f.runs.list().rows;
  const db = new DatabaseSync(join(f.directory, 'worker-runs.sqlite'));
  try {
    db.prepare('UPDATE worker_runs SET cpu_user=?,cpu_system=? WHERE id=?').run(100, 50, f.parent.id);
    for (const row of rows.slice(1)) db.prepare('UPDATE worker_runs SET cpu_user=?,cpu_system=? WHERE id=?').run(60, 30, row.id);
  } finally { db.close(); }
  const analysis = f.runs.analyze();
  assert.equal(analysis.resources.measuredRuns, 1);
  assert.equal(analysis.resources.cpuUserMicros, 100);
  assert.equal(analysis.resources.cpuSystemMicros, 50);
  assert.equal(analysis.consumption.inputTokens, 47);
  assert.equal(analysis.consumption.outputTokens, 23);
  assert.equal(analysis.consumption.runs, 3);
  assert.equal(f.runs.analyze({ sessionId: rows[1].sessionId }).resources.cpuUserMicros, null);
  assert.match(analysis.notes.join(' '), /child windows are excluded/);
});

test('failed evidence persistence prevents accepted child results without losing measured consumption', async t => {
  const f = await fixture(t);
  t.mock.method(f.runs, 'observeUsage', () => { throw Error('Fixture evidence write failed.'); });
  await assert.rejects(f.run(input()), /evidence write failed/);
  assert.equal(f.runs.list().rows[1].outcome, 'failed');
  assert.equal(f.runs.list().rows[1].usage.inputTokens, 20);
  assert.equal(f.consumption.status().measuredTokens, 30);
  assert.equal(f.consumption.status().uncertainInvocations, 1);
});

test('an ended parent cannot dispatch a child even after its child run was admitted', async t => {
  let dispatched = 0;
  const f = await fixture(t);
  const run = createDelegationChildRunner({ ...f.options, model: factory(async (_request, _signal, _observe, control) => {
    await f.runs.finish(f.parent.id, 'cancelled');
    control?.beforeCall(); dispatched++; return { type: 'completed', text: 'Never accepted.' };
  }) });
  await assert.rejects(run(input()), { code: 'conflict' });
  assert.equal(dispatched, 0);
  assert.equal(f.consumption.status().chargedTokens, 0);
  assert.equal(f.consumption.status().uncertainInvocations, 0);
  assert.equal(f.runs.list().rows[1].outcome, 'failed');
});


test('delegated subprocesses use the child session and run while keeping the parent FR and task', async t => {
  const observations = createProcessObservation();
  const f = await fixture(t, factory(async (_request, signal) => {
    await runProcess(process.execPath, ['-e', ''], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, signal, maxOutputBytes: 1024 });
    return { type: 'completed', text: 'Observed child fixture.' };
  }));
  const run = createDelegationChildRunner({ ...f.options, observations });
  const result = await observations.run({ featureRequestKey: f.options.featureRequestKey, sessionId: f.parent.sessionId, runId: f.parent.id }, () => run(input()));
  const record = (await observations.status()).processes[0], child = f.runs.list().rows.find(row => row.sessionId === result.sessionId);
  assert.ok(child); assert.equal(record.sessionId, result.sessionId); assert.equal(record.runId, child.id);
  assert.notEqual(record.runId, f.parent.id); assert.equal(record.featureRequestKey, f.options.featureRequestKey); assert.equal(record.taskId, f.parent.taskId);
});


for (const tool of ['werk_file_read', 'werk_candidate_status', 'werk_candidate_apply', 'werk_candidate_check']) test(`candidate parent delegation retains only relevant frozen inspection evidence for ${tool}`, async t => {
  const captured = { candidateSourceMaxBytes: 134217728, candidateSourceMaxFiles: 40000, candidateFileMaxBytes: 16777216 };
  let requests = 0;
  const f = await fixture(t, factory(async request => {
    requests++;
    assert.deepEqual(request.toolManifest.tools.map(item => item.name), [tool]);
    assert.deepEqual(request.toolManifest.limits.candidateInspection, tool === 'werk_file_read' ? undefined : captured);
    for (const field of Object.keys(captured)) assert.equal(request.policy[field], tool === 'werk_candidate_apply' ? captured[field] : undefined);
    assert.equal(request.policy.development, tool === 'werk_candidate_apply' ? true : undefined);
    assert.equal(request.operation, tool === 'werk_candidate_apply' ? 'patch' : 'chat');
    return { type: 'completed', text: 'Same accepted candidate; narrowed child authority.' };
  }));
  const parent = tools();
  parent.manifest.tools = ['werk_file_read', 'werk_candidate_status', 'werk_candidate_apply', 'werk_candidate_check', 'werk_delegate'].map(name => ({ name, description: 'Approved fixture tool', inputSchema: { type: 'object' } }));
  parent.manifest.limits = { maxCalls: 8, windowMs: 10000, callTimeoutMs: {}, candidateInspection: captured };
  const broker = delegationTool({ enabled: true, maxChildren: 4, maxConcurrent: 2 }, () => parent, { runChild: f.run, record: async () => {} });
  assert.ok(broker);
  const response = await broker.call({ tasks: [{ id: 'narrowed', prompt: 'Inspect the same Feature Request.', tools: [tool] }] }, new AbortController().signal);
  const result = JSON.parse(response.content[0].text).children[0];
  assert.equal(result.state, 'completed', result.error); assert.equal(requests, 1);
  assert.deepEqual(parent.manifest.limits.candidateInspection, captured, 'narrowing never mutates the parent evidence');
});
