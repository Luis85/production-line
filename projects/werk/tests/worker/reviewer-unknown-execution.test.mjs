import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture as readyFixture, input as readyInput, wait } from './ready-review-fixtures.mjs';
import { reviewerFixture, reviewerInput } from './request-review-fixtures.mjs';
import { ProviderModelError } from '../../src/worker/dist/worker/application/model-contract.js';
import { RequestReviewManager } from '../../src/worker/dist/worker/application/request-review.js';
import { SerialExecutor } from '../../src/worker/dist/worker/application/serial-executor.js';
import { WorkerRequestJournal } from '../../src/worker/dist/worker/infrastructure/journal/requests.js';
import { WorkerRunJournal } from '../../src/worker/dist/worker/infrastructure/journal/local-runs.js';
import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';

/** @type {Array<'outcome_unknown'|'process_stop_unconfirmed'>} */
const reasons = ['outcome_unknown', 'process_stop_unconfirmed'];
for (const reason of reasons) test(`Ready Check ${reason} retains capacity and exact attempt through shutdown and restart`, async t => {
  const f = await readyFixture(t, { respond: async (_request, signal) => {
    if (reason === 'process_stop_unconfirmed') await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw new ProviderModelError(reason);
  } });
  const input = readyInput('unknown-' + reason), accepted = await f.schedule(input);
  await wait(() => f.calls.length === 1);
  if (reason === 'process_stop_unconfirmed') await f.manager.close(); else await f.settle();
  const turn = f.sessions.interactions.turn(accepted.sessionId, accepted.turnId);
  assert.equal(turn.errorCode, reason, 'Caller cancellation must not replace unknown provider cessation.');
  assert.equal(turn.result, null); assert.equal(f.sessions.executor.current, null);
  assert.equal(f.sessions.executor.reservedExecutions.length, 1); assert.equal(f.sessions.executor.reservedExecutions[0].sessionId, accepted.sessionId);
  assert.equal(f.sessions.executor.canStart('another-request'), false);
  const retained = f.sessions.runs.uncertainExecutions(); assert.equal(retained.length, 1); assert.equal(retained[0].id, accepted.runId);
  assert.equal(retained[0].sessionId, accepted.sessionId); assert.equal(retained[0].purpose, 'gate_review');
  await f.restart(); assert.equal(f.sessions.executor.canStart('another-request'), false);
  const recovered = f.manager.inspect(input); assert.equal(recovered.state, 'failed'); assert.equal(recovered.error, reason);
  assert.deepEqual(await f.schedule(input), accepted); assert.equal(f.calls.length, 1);
  assert.equal(f.sessions.runs.uncertainExecutions()[0].id, accepted.runId);
});

test('Ready Check holds the live permit and unfinished run when unknown receipt persistence fails', async t => {
  const f = await readyFixture(t, { respond: async () => { throw new ProviderModelError('process_stop_unconfirmed'); } });
  const original = f.sessions.runs.reserveUnknown;
  f.sessions.runs.reserveUnknown = () => { throw Error('Fixture cannot persist the uncertainty receipt.'); };
  const input = readyInput('receipt-write-failure'), accepted = await f.schedule(input); await f.settle();
  assert.equal(f.sessions.executor.current, accepted.sessionId); assert.equal(f.sessions.executor.canStart('another-request'), false);
  const run = f.sessions.runs.get(accepted.runId); assert.equal(run.outcome, 'running'); assert.equal(run.after, null);
  assert.equal(f.sessions.interactions.turn(accepted.sessionId, accepted.turnId).errorCode, 'process_stop_unconfirmed');
  f.sessions.runs.reserveUnknown = original; await f.restart();
  assert.equal(f.sessions.executor.canStart('another-request'), false); assert.equal(f.sessions.runs.uncertainExecutions()[0].id, accepted.runId);
  await f.schedule(input); assert.equal(f.calls.length, 1);
});

/** @param {import('node:test').TestContext} t
 * @param {'outcome_unknown'|'process_stop_unconfirmed'} reason */
async function advisoryFixture(t, reason) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-advisory-unknown-'));
  /** @type {WorkerRequestJournal} */ let gates;
  /** @type {WorkerRunJournal} */ let runs;
  /** @type {SerialExecutor} */ let executor;
  /** @type {RequestReviewManager} */ let manager;
  let calls = 0;
  async function open() {
    gates = new WorkerRequestJournal(directory); runs = new WorkerRunJournal(directory); await gates.init(); await runs.init();
    executor = new SerialExecutor(() => false, () => 4, () => runs.uncertainExecutions().map(run => ({ sessionId: run.sessionId, projectId: null, projectLimit: 1 })));
    manager = new RequestReviewManager({ gates, runs, executor, model: () => ({ reply: async () => { throw Error('Structured model required.'); },
      async execute(_request, signal) { calls++; if (reason === 'process_stop_unconfirmed') await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); throw new ProviderModelError(reason); },
    }) });
  }
  await open();
  const policy = defaultGatePolicy(); policy.ready.patch.push({ id: 'needs-specificity', fact: 'input.messageLength', op: 'gte', value: 50 });
  const request = gates.ensure({ owner: { sessionId: 'advisory-session', rootTurnId: 'advisory-turn', taskId: 'advisory-task' }, input: reviewerInput, provider: { id: 'fixture', model: 'pinned-model', instruction: '' }, policy });
  gates.evaluate(request.id, 'ready');
  t.after(async () => { await manager.close(); gates.close(); runs.close(); await rm(directory, { recursive: true, force: true }); });
  return { requestId: request.id, get manager() { return manager; }, get runs() { return runs; }, get gates() { return gates; }, get executor() { return executor; }, get calls() { return calls; },
    async restart() { await manager.close(); gates.close(); runs.close(); await open(); },
  };
}
for (const reason of reasons) test(`advisory ${reason} preserves request/review/run identity and blocks unrelated work after restart`, async t => {
  const f = await advisoryFixture(t, reason); f.manager.tick(); await wait(() => f.calls === 1);
  if (reason === 'process_stop_unconfirmed') await f.manager.close(); else await wait(() => !f.manager.snapshot().active);
  const current = f.gates.get(f.requestId), review = current.reviews[0];
  assert.equal(review.errorCode, reason); assert.equal(review.result, null); assert.equal(current.phase, 'needs_rework');
  const reserved = f.runs.uncertainExecutions(); assert.equal(reserved.length, 1); assert.equal(reserved[0].id, review.runId); assert.equal(reserved[0].requestId, current.id); assert.equal(reserved[0].sessionId, current.owner.sessionId);
  assert.equal(f.executor.current, null); assert.equal(f.executor.canStart('another-project', { projectId: 'other', projectLimit: 4 }), false, 'Uncertain auxiliary work remains exclusive despite a larger worker limit.');
  await f.restart(); f.manager.tick(); await wait(() => !f.manager.snapshot().active);
  assert.equal(f.calls, 1); assert.equal(f.runs.uncertainExecutions()[0].id, review.runId); assert.equal(f.executor.canStart('another-project', { projectId: 'other', projectLimit: 4 }), false);
});

test('advisory unknown receipt failure retains the permit and never records known completion', async () => {
  const f = reviewerFixture({ model: async () => { throw new ProviderModelError('outcome_unknown'); } });
  f.manager.tick(); await wait(() => !f.manager.snapshot().active);
  assert.equal(f.intent.errorCode, 'outcome_unknown'); assert.equal(f.manager.snapshot().persistenceError, true);
  assert.equal(f.executor.current, 'session-1'); assert.equal(f.records[0].outcome, 'running'); assert.equal(f.events.includes('finished'), false);
  f.manager.tick(); assert.equal(f.calls, 1); await f.manager.close(); assert.equal(f.executor.canStart('other'), false);
});
