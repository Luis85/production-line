import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { sampleOwnedProcessGroup } from '../../src/worker/dist/worker/infrastructure/processes/sampler.js';

function stat(group, state = 'S') {
  const fields = Array(22).fill('0');
  fields[0] = state; fields[2] = String(group); fields[11] = '3'; fields[12] = '2'; fields[21] = '4';
  return '1 (fixture process) ' + fields.join(' ');
}
const source = overrides => ({ platform: 'linux', dimensions: async () => ({ ticks: 100, pageSize: 4096 }),
  entries: async () => ['self', '1', '2', '3'], stat: async name => stat(name === '2' ? 77 : 42, name === '3' ? 'Z' : 'S'), ...overrides });
const sampler = (overrides = {}, timeoutMs = 5000) => (group, signal = /** @type {AbortSignal | undefined} */ (undefined)) => sampleOwnedProcessGroup(group, signal, { source: source(overrides), timeoutMs });
const unavailable = result => {
  assert.equal(result.coverage, 'unavailable');
  assert.equal(result.cpuTotalMicros, null); assert.equal(result.rssBytes, null); assert.equal(result.processCount, null);
  assert.match(result.unavailableReason, /cancelled|budget/);
};

test('a complete scan counts only live members of its exact owned process group', async () => {
  const result = await sampler()(42);
  assert.equal(result.coverage, 'complete_group');
  assert.equal(result.cpuTotalMicros, 50000); assert.equal(result.rssBytes, 16384); assert.equal(result.processCount, 1);
});

test('pre-cancelled measurement does not start filesystem work', async () => {
  let reads = 0;
  const sample = sampler({ dimensions: async () => { reads++; throw Error('must not read'); } });
  unavailable(await sample(42, AbortSignal.abort()));
  assert.equal(reads, 0);
});

test('ownership cancellation discards partial totals and prevents the next process read', async () => {
  const controller = new AbortController(), reads = [];
  const sample = sampler({ stat: async name => { reads.push(name); controller.abort(); return stat(42); } });
  unavailable(await sample(42, controller.signal));
  assert.deepEqual(reads, ['1']);
});

test('cancellation during directory enumeration prevents all following stat reads', async () => {
  const controller = new AbortController(); let reads = 0;
  const sample = sampler({ entries: async () => { controller.abort(); return ['1']; }, stat: async () => { reads++; return stat(42); } });
  unavailable(await sample(42, controller.signal));
  assert.equal(reads, 0);
});

test('the scan deadline aborts a pending read and never reports partial counters', { timeout: 2000 }, async () => {
  const reads = []; let aborted = false;
  const sample = sampler({ stat: async (name, signal) => {
    reads.push(name);
    if (name === '1') return stat(42);
    try { await delay(10000, undefined, { signal }); }
    finally { aborted = signal.aborted; }
    return stat(42);
  } }, 20);
  unavailable(await sample(42));
  assert.equal(aborted, true); assert.deepEqual(reads, ['1', '2']);
});
