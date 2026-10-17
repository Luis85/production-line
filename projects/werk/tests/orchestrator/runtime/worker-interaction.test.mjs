import { testErrorCode, testErrorMessage } from '../../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { workerInteraction } from '../../../src/orchestrator/dist/orchestrator/application/worker-interaction.js';
import { validateWorkerInteractionResponse } from '../../../src/orchestrator/dist/shared/worker-interaction.js';
import { DomainError } from '../../../src/orchestrator/dist/shared/errors.js';

const chat = () => ({ available: true, busy: false, phase: 'idle', messages: [], request: { revision: 3 } });
const session = (selected = 'original') => ({ sessions: { selected, records: [{ id: selected, title: 'Task', provider: 'claude-cli', definition: { revision: 2 } }], execution: { maxParallel: 1 } }, chat: chat() });
function fixture() {
  const calls = []; let selected = 'original';
  return { calls, worker: {
    async status() { calls.push(['status']); return { workerId: 'registered' }; },
    async session() { calls.push(['session']); return session(selected); },
    async createSession(provider) { calls.push(['create', provider]); selected = 'created'; return session(selected).sessions; },
    async send(id, message) { calls.push(['send', id, message]); return chat(); },
    async cancel(id) { calls.push(['cancel', id]); return chat(); },
  } };
}
test('interaction application checks registered identity before reading or mutating worker state', async () => {
  const f = fixture();
  await assert.rejects(workerInteraction({ action: 'send', sessionId: 'original', message: 'Follow up' }, f.worker, () => { throw new DomainError('not_found', 'Unregistered'); }), error => testErrorCode(error) === 'not_found');
  assert.deepEqual(f.calls, [['status']]);
});
test('interaction application uses selected provider once and fences a session switch after creation', async () => {
  const f = fixture();
  const result = await workerInteraction({ action: 'new', sessionId: 'original' }, f.worker, id => assert.equal(id, 'registered'));
  assert.deepEqual(f.calls, [['status'], ['session'], ['create', 'claude-cli'], ['session']]);
  assert.equal(result.sessions.selected, 'created');
  assert.deepEqual(result.sessions.execution, { maxParallel: 1 });
  const switched = fixture(); let reads = 0;
  switched.worker.session = async () => session(++reads === 1 ? 'original' : 'changed');
  await assert.rejects(workerInteraction({ action: 'new', sessionId: 'original' }, switched.worker, () => {}), error => testErrorCode(error) === 'conflict');
  assert.equal(switched.calls.filter(([action]) => action === 'create').length, 1);
});
test('interaction application carries the same session through send and cancel', async () => {
  const f = fixture();
  await workerInteraction({ action: 'send', sessionId: 'original', message: 'Follow up' }, f.worker, () => {});
  await workerInteraction({ action: 'cancel', sessionId: 'original' }, f.worker, () => {});
  assert.deepEqual(f.calls, [['status'], ['send', 'original', 'Follow up'], ['status'], ['cancel', 'original']]);
});
test('shared interaction response validation preserves extensions and rejects malformed consumed fields safely', () => {
  const value = { workerId: 'registered', ...session(), extension: { version: 2 } };
  assert.equal(validateWorkerInteractionResponse(value), value);
  assert.deepEqual(value.chat.request, { revision: 3 });
  for (const malformed of [null, [], { ...value, workerId: 'PRIVATE DIAGNOSTIC' }, { ...value, chat: { ...chat(), busy: 'yes' } }, { ...value, sessions: { selected: 'missing', records: [] } }]) {
    assert.throws(() => validateWorkerInteractionResponse(malformed), error => testErrorCode(error) === 'unavailable' && !testErrorMessage(error).includes('PRIVATE DIAGNOSTIC'));
  }
});

for (const step of ['status', 'session', 'createSession']) test('cancelled interaction fences late ' + step + ' completion', async () => {
  const f = fixture(), controller = new AbortController(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const original = f.worker[step]; let checked = 0;
  f.worker[step] = async (...args) => { const result = await original(...args); entered.resolve(); await release.promise; return result; };
  const pending = workerInteraction({ action: 'new', sessionId: 'original' }, f.worker, () => { checked++; }, controller.signal);
  const rejected = assert.rejects(pending, error => testErrorCode(error) === 'unavailable');
  await entered.promise; controller.abort(); release.resolve(); await rejected;
  assert.equal(checked, step === 'status' ? 0 : 1);
  assert.deepEqual(f.calls.map(([action]) => action), step === 'status' ? ['status'] : step === 'session' ? ['status', 'session'] : ['status', 'session', 'create']);
});

test('already cancelled interaction cannot contact its worker', async () => {
  const f = fixture();
  await assert.rejects(workerInteraction({ action: 'read' }, f.worker, () => {}, AbortSignal.abort()), error => testErrorCode(error) === 'unavailable');
  assert.deepEqual(f.calls, []);
});
