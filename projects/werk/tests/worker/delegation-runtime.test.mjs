import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultDelegationPolicy, validateDelegationPolicy } from '../../src/worker/dist/worker/application/delegation-policy.js';
import { defaultToolPolicy, persistedToolPolicy, publicToolPolicy, updateToolPolicy, validateToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { unknownUsage } from '../../src/worker/dist/worker/application/run-evidence.js';
import { createToolRuntime } from '../../src/worker/dist/worker/infrastructure/tool-runtime.js';
import { delegationTool } from '../../src/worker/dist/worker/infrastructure/delegation-tools.js';

const controller = () => new AbortController();
const grant = () => ({ enabled: true, maxChildren: 4, maxConcurrent: 2 });
const task = (id, extra = {}) => ({ id, prompt: 'Inspect the current feature: ' + id, ...extra });
/** @returns {import('../../src/worker/dist/worker/application/delegation.js').DelegationChildResult} */
const completion = id => ({ sessionId: 'child-' + id, result: { type: 'completed', text: 'Report ' + id }, usage: unknownUsage() });
const children = result => JSON.parse(result.content[0].text).children;

/** @param {import('node:test').TestContext} t
 * @param {import('../../src/worker/dist/worker/application/delegation.js').DelegationPorts['runChild']} runChild
 * @param {{ maxCalls?: number; maxRuntimeMs?: number; maxConcurrent?: number; record?: import('../../src/worker/dist/worker/application/delegation.js').DelegationPorts['record'] }} [options]
 */
async function fixture(t, runChild, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-delegation-'));
  const policy = defaultToolPolicy(); policy.delegation = { ...grant(), ...(options.maxConcurrent ? { maxConcurrent: options.maxConcurrent } : {}) };
  const state = { revision: policy.revision, reads: 0 }, receipts = [];
  /** @type {import('../../src/worker/dist/worker/application/tool-runtime.js').ToolRuntime} */
  let runtime;
  const operation = delegationTool(policy.delegation, () => runtime, { runChild, record: async receipt => { if (options.record) await options.record(receipt); receipts.push(structuredClone(receipt)); } });
  assert.ok(operation);
  runtime = createToolRuntime({ directory, policy, currentRevision: () => state.revision, maxCalls: options.maxCalls ?? 64, maxRuntimeMs: options.maxRuntimeMs ?? 10000,
    additionalOperations: [operation, { definition: { name: 'fixture_read', description: 'Read the same approved fixture.', inputSchema: { type: 'object' } }, async call() { state.reads++; return { content: [{ type: 'text', text: 'read-' + state.reads }] }; } }],
  });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  return { runtime, state, receipts, delegate: tasks => runtime.call('werk_delegate', { tasks }, controller().signal) };
}

test('delegation is explicitly off for old policies, persists bounded grants and preserves them through old-client updates', () => {
  const policy = defaultToolPolicy(), saved = persistedToolPolicy(policy);
  assert.equal(policy.delegation, undefined); assert.equal(defaultDelegationPolicy().enabled, false);
  const edit = { expectedRevision: policy.revision, builtins: policy.builtins, mcp: [] };
  const enabled = updateToolPolicy(policy, { ...edit, delegation: grant() });
  assert.deepEqual(publicToolPolicy(enabled).delegation, grant());
  assert.deepEqual(validateToolPolicy(persistedToolPolicy(enabled)).delegation, grant());
  assert.deepEqual(updateToolPolicy(enabled, { ...edit, expectedRevision: enabled.revision }).delegation, grant());
  assert.deepEqual(persistedToolPolicy(validateToolPolicy(saved)), saved);
  for (const invalid of [null, {}, { ...grant(), enabled: 'yes' }, { ...grant(), maxChildren: 5 }, { ...grant(), maxChildren: 0 }, { ...grant(), maxChildren: 1.5 }, { ...grant(), maxConcurrent: 3 }, { ...grant(), maxConcurrent: 0 }, { ...grant(), maxChildren: 1 }, { ...grant(), depth: 2 }]) {
    assert.throws(() => validateDelegationPolicy(invalid), /delegation grant/);
    assert.throws(() => updateToolPolicy(policy, { ...edit, delegation: invalid }), /delegation grant/);
  }
  assert.equal(delegationTool(undefined, () => { throw Error('Must stay lazy'); }, { runChild: async () => { throw Error('Must stay off'); }, record: async () => {} }), undefined);
});

test('one parent permits four children total, runs only two concurrently and reuses exact child results', async t => {
  const gates = Array.from({ length: 4 }, () => Promise.withResolvers());
  const firstPair = Promise.withResolvers(), secondPair = Promise.withResolvers();
  let active = 0, maximum = 0, calls = 0;
  const f = await fixture(t, async ({ id }) => {
    const index = Number(id); calls++; active++; maximum = Math.max(maximum, active);
    if (calls === 2) firstPair.resolve(undefined); if (calls === 4) secondPair.resolve(undefined);
    try { await gates[index].promise; return completion(id); } finally { active--; }
  });
  const requested = [0, 1, 2, 3].map(id => task(String(id)));
  const result = f.delegate(requested);
  await firstPair.promise; assert.equal(calls, 2); assert.equal(active, 2);
  gates[0].resolve(undefined); gates[1].resolve(undefined); await secondPair.promise;
  assert.equal(maximum, 2); gates[2].resolve(undefined); gates[3].resolve(undefined);
  assert.equal(children(await result).length, 4);
  assert.equal(f.receipts.filter(item => item.state === 'started').length, 4);
  assert.equal(f.receipts.filter(item => item.state === 'completed').length, 4);
  assert.equal(children(await f.delegate(requested)).length, 4); assert.equal(calls, 4, 'replayed IDs never dispatch a second paid call');
  assert.match((await f.delegate([task('4')])).content[0].text, /child limit/);
  assert.match((await f.delegate([task('0', { prompt: 'Different work' })])).content[0].text, /different instructions/);
  assert.equal(calls, 4);
});

test('child tools borrow the parent budget and serial queue without deadlock or closing parent authority', async t => {
  /** @type {import('../../src/worker/dist/worker/application/tool-runtime.js').ToolRuntime | undefined} */
  let childRuntime;
  const f = await fixture(t, async ({ id, tools, signal }) => {
    childRuntime = tools;
    assert.deepEqual(tools.manifest.tools.map(tool => tool.name), ['fixture_read']);
    await assert.rejects(tools.call('werk_delegate', {}, signal), /not granted/);
    await assert.rejects(tools.call('ungranted', {}, signal), /not granted/);
    assert.equal((await tools.call('fixture_read', {}, signal)).content[0].text, 'read-1');
    return completion(id);
  });
  const result = await f.delegate([task('inspect', { tools: ['fixture_read'] })]);
  assert.equal(children(result)[0].state, 'completed'); assert.equal(f.state.reads, 1);
  assert.ok(childRuntime);
  await assert.rejects(childRuntime.call('fixture_read', {}, controller().signal), /ended/);
  assert.equal((await f.runtime.call('fixture_read', {}, controller().signal)).content[0].text, 'read-2');
  assert.equal(f.runtime.budget().callsUsed, 3, 'delegate plus child read plus parent read share one allowance');
  assert.match((await f.delegate([task('nested', { tools: ['werk_delegate'] })])).content[0].text, /nested delegation/);
  assert.match((await f.delegate([task('unknown', { tools: ['missing'] })])).content[0].text, /subset/);
});

test('children cannot reset a depleted parent tool budget', async t => {
  const f = await fixture(t, async ({ id, tools, signal }) => {
    assert.equal((await tools.call('fixture_read', {}, signal)).isError, undefined);
    const refused = await tools.call('fixture_read', {}, signal);
    assert.equal(refused.isError, true); assert.match(refused.content[0].text, /budget exhausted/i);
    return completion(id);
  }, { maxCalls: 2 });
  await f.delegate([task('budget')]);
  assert.equal(f.state.reads, 1); assert.equal(f.runtime.budget().callsUsed, 2); assert.equal(f.runtime.budget().refusedCalls, 1);
});

test('grant revocation stops queued child model dispatch even when the child requests no tools', async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers(); let calls = 0;
  const f = await fixture(t, async ({ id }) => { calls++; entered.resolve(undefined); await finish.promise; return completion(id); }, { maxConcurrent: 1 });
  const result = assert.rejects(f.delegate([task('one', { tools: [] }), task('two', { tools: [] })]), /permissions changed/);
  await entered.promise; f.state.revision++; finish.resolve(undefined); await result;
  assert.equal(calls, 1); assert.equal(f.receipts.filter(item => item.state === 'failed').length, 2);
});

test('closing the parent cancels children and waits for their cleanup before releasing the invocation', async t => {
  const entered = Promise.withResolvers(), cleanup = Promise.withResolvers(), finish = Promise.withResolvers(); let calls = 0;
  const f = await fixture(t, async ({ signal }) => {
    calls++; if (calls === 2) entered.resolve(undefined);
    try { await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('stopped')), { once: true })); }
    finally { cleanup.resolve(undefined); await finish.promise; }
    throw Error('cancelled child cannot return');
  });
  const delegated = assert.rejects(f.delegate([task('one'), task('two'), task('three')]), /cancelled|ended/i);
  await entered.promise;
  let closed = false; const closing = f.runtime.close().then(() => { closed = true; });
  await cleanup.promise; assert.equal(closed, false); finish.resolve(undefined);
  await closing; await delegated; assert.equal(calls, 2); assert.equal(f.receipts.filter(item => item.state === 'cancelled').length, 3);
});

test('receipt persistence is required before paid child dispatch and failure stops the entire parent child batch', async t => {
  let calls = 0;
  const f = await fixture(t, async ({ id }) => { calls++; return completion(id); }, { record: async () => { throw Error('private storage detail'); } });
  const result = await f.delegate([task('one'), task('two'), task('three')]);
  assert.equal(result.isError, true); assert.match(result.content[0].text, /evidence/); assert.doesNotMatch(result.content[0].text, /private storage detail/);
  assert.equal(calls, 0);
  await f.delegate([task('four')]); assert.equal(calls, 0);
});

test('child reports are byte bounded for Unicode and failure details never disclose private adapter diagnostics', async t => {
  const f = await fixture(t, async ({ id }) => ({ ...completion(id), result: { type: 'completed', text: '🙂'.repeat(20000) } }));
  const result = await f.delegate(['one', 'two', 'three', 'four'].map(id => task(id)));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 131072); assert.equal(result.isError, undefined);
  assert.match(children(result)[0].result.text, /shortened/); assert.doesNotMatch(children(result)[0].result.text, /�/);
  const failing = await fixture(t, async () => { throw Error('private-provider-secret'); });
  const failure = await failing.delegate([task('failure')]);
  assert.equal(failure.isError, true); assert.doesNotMatch(JSON.stringify(failure), /private-provider-secret/);
});


test('a concurrent receipt failure prevents a sibling starting after its delayed receipt succeeds', async t => {
  const first = Promise.withResolvers(), second = Promise.withResolvers(), both = Promise.withResolvers();
  let records = 0, calls = 0;
  const f = await fixture(t, async ({ id }) => { calls++; return completion(id); }, { record: async receipt => {
    if (receipt.state !== 'started') return;
    records++; if (records === 2) both.resolve(undefined);
    await (receipt.id === 'one' ? first.promise : second.promise);
  } });
  const result = f.delegate([task('one'), task('two')]);
  await both.promise;
  first.reject(Error('First durable receipt failed'));
  await new Promise(resolve => setImmediate(resolve));
  second.resolve(undefined);
  assert.equal((await result).isError, true); assert.equal(calls, 0);
});
