import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { prepareProcessRuntime } from '../../src/worker/dist/shared/process/launcher.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { ProviderModelError, prepareModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';
import { createToolRuntime } from '../../src/worker/dist/worker/infrastructure/tool-runtime.js';
import { delegationTool } from '../../src/worker/dist/worker/infrastructure/delegation-tools.js';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { withProviderTools } from '../../src/worker/dist/worker/infrastructure/provider-tool-session.js';
import { withCliToolBridge } from '../../src/worker/dist/worker/infrastructure/cli-tool-bridge.js';

// Native setup has a 45-second limit; allow five seconds to drain before scenario budgets start.
before(async t => prepareProcessRuntime(process.cwd(), t.signal), { timeout: 50000 });

const task = id => ({ id, prompt: 'Inspect the same Feature Request.', tools: [] });
/** @param {import('node:test').TestContext} t
 * @param {import('../../src/worker/application/delegation.ts').DelegationPorts['runChild']} runChild
 * @param {import('../../src/worker/application/delegation.ts').DelegationPorts['record']} [record] */
async function fixture(t, runChild, record = async () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-child-uncertainty-'));
  const policy = defaultToolPolicy(); policy.delegation = { enabled: true, maxChildren: 4, maxConcurrent: 2 };
  /** @type {import('../../src/worker/application/tool-runtime.ts').ToolRuntime} */
  let runtime;
  /** @type {import('../../src/worker/application/delegation.ts').DelegationReceipt[]} */
  const receipts = [];
  let ordinaryCalls = 0;
  const operation = delegationTool(policy.delegation, () => runtime, { runChild, record: async receipt => { await record(receipt); receipts.push(structuredClone(receipt)); } });
  assert.ok(operation);
  runtime = createToolRuntime({ directory, policy, currentRevision: () => policy.revision, maxCalls: 32, maxRuntimeMs: 10000,
    additionalOperations: [operation, { definition: { name: 'fixture_read', description: 'Read fixture.', inputSchema: { type: 'object' } }, async call() { ordinaryCalls++; return { content: [{ type: 'text', text: 'Read.' }] }; } }],
  });
  t.after(async () => { await runtime.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  return { runtime, receipts, ordinaryCalls: () => ordinaryCalls };
}

for (const code of /** @type {const} */ (['outcome_unknown', 'process_stop_unconfirmed'])) test(`${code} drains active siblings, cancels queued children and remains fatal after parent cancellation`, { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(), fail = Promise.withResolvers(), cleanup = Promise.withResolvers(), stopped = Promise.withResolvers();
  const controller = new AbortController(), calls = [];
  let settled = false;
  const f = await fixture(t, async ({ id, signal }) => {
    calls.push(id); if (calls.length === 2) entered.resolve(undefined);
    if (id === 'first') { await fail.promise; throw new ProviderModelError(code); }
    await new Promise(resolve => signal.aborted ? resolve(undefined) : signal.addEventListener('abort', resolve, { once: true }));
    stopped.resolve(undefined); await cleanup.promise; throw new ProviderModelError('cancelled');
  });
  t.after(() => { fail.resolve(undefined); cleanup.resolve(undefined); });
  const pending = f.runtime.call('werk_delegate', { tasks: ['first', 'sibling', 'queued1', 'queued2'].map(task) }, controller.signal);
  const assertion = assert.rejects(pending, { code });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await entered.promise; fail.resolve(undefined); await stopped.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'capacity stays held until the active sibling finishes cleanup');
  assert.deepEqual(calls, ['first', 'sibling']);
  assert.equal(f.runtime.failureSignal?.aborted, true, 'parent tools are fenced before sibling cleanup');
  await assert.rejects(f.runtime.call('fixture_read', {}, new AbortController().signal), { code });
  assert.equal(f.ordinaryCalls(), 0); controller.abort(); cleanup.resolve(undefined); await assertion;
  assert.equal(f.receipts.find(item => item.id === 'first' && item.state === 'failed')?.errorCode, code);
  assert.deepEqual(f.receipts.filter(item => item.state === 'started').map(item => item.id), ['first', 'sibling']);
  assert.equal(f.runtime.failureSignal?.aborted, true);
  assert.throws(() => f.runtime.assertAvailable(controller.signal), { code });
  await assert.rejects(f.runtime.call('fixture_read', {}, new AbortController().signal), { code });
  await assert.rejects(f.runtime.call('werk_delegate', { tasks: [task('retry')] }, new AbortController().signal), { code });
  await assert.rejects(f.runtime.close(), { code }); assert.equal(f.ordinaryCalls(), 0); assert.equal(calls.length, 2);
});

test('an unstopped sibling outranks a generic child failure and an earlier uncertain outcome', async t => {
  const firstFailed = Promise.withResolvers();
  const f = await fixture(t, async ({ id, signal }) => {
    if (id === 'generic') { firstFailed.resolve(undefined); throw Error('Known ordinary failure.'); }
    if (id === 'unknown') { await firstFailed.promise; throw new ProviderModelError('outcome_unknown'); }
    await new Promise(resolve => signal.aborted ? resolve(undefined) : signal.addEventListener('abort', resolve, { once: true }));
    throw new ProviderModelError('process_stop_unconfirmed');
  });
  // Concurrent calls share one broker; the third child must have started before the first uncertainty.
  const generic = f.runtime.call('werk_delegate', { tasks: [task('generic')] }, new AbortController().signal);
  await generic;
  const pending = f.runtime.call('werk_delegate', { tasks: [task('unstopped'), task('unknown')] }, new AbortController().signal);
  await assert.rejects(pending, { code: 'process_stop_unconfirmed' });
  assert.equal(f.receipts.find(item => item.id === 'unstopped' && item.state === 'failed')?.errorCode, 'process_stop_unconfirmed');
  await assert.rejects(f.runtime.close(), { code: 'process_stop_unconfirmed' });
});

test('failed terminal child evidence cannot erase unknown outcome or dispatch queued work', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw new ProviderModelError('outcome_unknown'); }, async receipt => {
    if (receipt.state !== 'started') throw Error('Durable evidence storage unavailable.');
  });
  await assert.rejects(f.runtime.call('werk_delegate', { tasks: ['a', 'b', 'c', 'd'].map(task) }, new AbortController().signal), { code: 'outcome_unknown' });
  assert.equal(calls, 2); assert.equal(f.runtime.failureSignal?.aborted, true);
  await assert.rejects(f.runtime.close(), { code: 'outcome_unknown' });
});

for (const code of /** @type {const} */ (['outcome_unknown', 'process_stop_unconfirmed'])) test(`CLI bridge serialization cannot turn ${code} into a successful parent result`, { timeout: 10000 }, async t => {
  const f = await fixture(t, async () => { throw new ProviderModelError(code); });
  const model = modelFor({ id: 'openai-api', apiKey: 'fixture', model: 'fixture', executable: '' }, '/unused', undefined, { tools: () => f.runtime });
  assert.ok(model);
  const request = prepareModelRequest(model, [{ id: 'user', role: 'user', text: 'Delegate safely.', at: '2026-10-20T00:00:00Z', state: 'complete' }]);
  let serialized = false;
  await assert.rejects(withProviderTools(request, new AbortController().signal, () => f.runtime, (runtime, signal) => withCliToolBridge(runtime, signal, async bridge => {
    assert.ok(bridge);
    const configuration = JSON.parse(await readFile(bridge.args[1], 'utf8'));
    const response = await fetch(configuration.url, { method: 'POST', headers: { authorization: 'Bearer ' + configuration.token, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'tools/call', params: { name: 'werk_delegate', arguments: { tasks: [task('child')] } } }) });
    assert.equal(response.status, 403); await response.arrayBuffer(); serialized = true;
    assert.equal(signal.aborted, true, 'the CLI invocation receives fatal child cancellation');
    return 'A CLI may ignore the serialized tool error and emit a nominal final answer.';
  })), { code });
  assert.equal(serialized, true);
});
