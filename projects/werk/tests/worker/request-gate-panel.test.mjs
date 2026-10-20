import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as vue from 'vue';
import { frontend, deferred } from '../ui/helpers/frontend-loader.mjs';
const projection = await frontend('src/worker/webview/feature-review.ts');
const controller = await frontend('src/worker/webview/request-gate-controller.ts');
const humanReview = await frontend('src/worker/webview/delivery-human-review.ts');
const source = await readFile(new URL('../../src/worker/webview/components/useRequestGatePanel.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const at = '2026-10-18T12:00:00Z';
/** @returns {import('../../src/worker/application/request-gates').WorkerRequest} */
function record() {
  return { schemaVersion: 1, id: 'request-a', owner: { sessionId: 'session-a', rootTurnId: 'turn-a' }, revision: 3, inputRevision: 1,
    input: { kind: 'chat', title: 'Review a feature', message: 'Implement the accepted request.' }, inputHash: 'input-a', policyDigest: 'policy-a',
    policy: { schemaVersion: 1, id: 'checks', version: 1, ready: { chat: [], patch: [] }, done: { chat: [{ id: 'accept', fact: 'operator.accepted', op: 'eq', value: true }], patch: [] }, reviewer: { enabled: false, provider: 'same', maxAttempts: 1 }, rework: { maxAttempts: 2 } },
    provider: { id: 'codex-cli', model: 'model', instruction: '' }, phase: 'review', assignee: 'operator', createdAt: at, updatedAt: at, reworkCount: 0,
    evaluations: [{ id: 'evaluation-a', stage: 'done', inputRevision: 1, inputHash: 'input-a', policyDigest: 'policy-a', outputDigest: 'output-a', at, passed: false, facts: {}, rules: [{ ruleId: 'accept', fact: 'operator.accepted', expected: true, observed: null, result: 'unknown' }] }],
    findings: [{ id: 'finding-a', kind: 'gap', message: 'Acceptance needed.', source: 'deterministic', evaluationId: 'evaluation-a', ruleId: 'accept', status: 'open', blocking: true }],
    candidates: [], reviews: [], attestation: null,
    execution: { turnId: 'turn-a', runId: 'run-a', inputRevision: 1, status: 'completed', outcome: 'completed', result: { type: 'completed', text: 'The result.' }, outputDigest: 'output-a', facts: {} } };
}
function fixture(api = async (_command) => undefined, overrides = {}) {
  const state = vue.reactive({ sessions: { selected: 'unrelated-session', records: [] }, unlocked: true, paused: false });
  const props = vue.reactive({ requestId: 'request-a', sessionId: 'session-a', disabled: false, featureSource: undefined, ...overrides });
  const changes = [], calls = [], focused = [], operations = vue.reactive(new Map());
  const exports = {}, scope = vue.effectScope();
  const ports = {
    vue: { ...vue, onMounted() {}, onActivated() {}, onDeactivated() {}, onBeforeUnmount() {} },
    '../../../shared/webview/composables/useBoundedPolling': { useBoundedPolling() {} },
    '../store': { state, request: async (_path, _method, command) => { calls.push(structuredClone(vue.toRaw(command))); return api(command); }, refresh: async () => {}, date: value => value },
    '../request-gate-controller': controller,
    '../feature-review': projection,
    '../delivery-human-review': humanReview,
    './request-gate-drafts': { requestDrafts: vue.reactive(new Map()), requestOperations: operations },
  };
  const usePanel = new Function('require', 'exports', 'document', javascript + '; return exports.useRequestGatePanel;')(id => {
    assert.ok(id in ports, 'Unexpected module: ' + id);
    return ports[id];
  }, exports, { getElementById: id => ({ focus: () => focused.push(id) }) });
  const panel = scope.run(() => usePanel(props, (event, value) => changes.push([event, value])));
  panel.gateState.view = record(); panel.gateState.loaded = true;
  return { ...panel, state, props, calls, operations, changes, focused, close: () => scope.stop() };
}

test('required acceptance is tied to current output and does not create a new policy requirement', t => {
  const f = fixture(); t.after(f.close);
  assert.equal(f.canAttest.value, true);
  f.view.value.execution.inputRevision = 0; assert.equal(f.canAttest.value, false);
  f.view.value.execution.inputRevision = 1;
  assert.equal(f.review.value.nextStep.action.kind, 'attest');
  assert.equal(f.acceptanceFinding(f.view.value.findings[0]), true);
  f.view.value.attestation = { actor: 'operator', inputHash: 'input-a', outputDigest: 'old-output', note: 'Earlier review', at };
  assert.equal(f.canAttest.value, true);
  f.view.value.attestation.outputDigest = 'output-a';
  assert.equal(f.canAttest.value, false);
  f.view.value.attestation = null; f.view.value.policy.done.chat = [];
  assert.equal(f.canAttest.value, false);
});

test('explicit shared Feature Request source blocks scope changes even without a session record', async t => {
  const current = record(), f = fixture(async () => ({ request: current, duplicate: false }), { featureSource: 'shared_git' }); t.after(f.close);
  assert.equal(f.sharedRequest.value, true); assert.equal(f.scopeMutable.value, false);
  for (const action of ['execute', 'rework', 'propose', 'accept_candidate']) await f.command({ action });
  assert.equal(f.calls.length, 0);
  await f.command({ action: 'evaluate', stage: 'done' });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].expectedRevision, 3);
});

test('an outer stale/read-only page blocks fresh mutations and an unretained retry', async t => {
  const f = fixture(); t.after(f.close);
  f.props.disabled = true;
  assert.equal(f.mutable.value, false);
  await f.command({ action: 'cancel' });
  await f.send({ action: 'evaluate', stage: 'done', requestId: 'request-a', expectedRevision: 3, operationId: 'saved' });
  assert.equal(f.calls.length, 0);
  f.props.disabled = false; f.gateState.stale = true;
  await f.command({ action: 'evaluate', stage: 'done' });
  assert.equal(f.calls.length, 0);
});

test('only the invoked action shows progress while other actions keep stable labels', async t => {
  const response = deferred(), f = fixture(() => response.promise); t.after(f.close);
  const running = f.command({ action: 'assign', assignee: 'llm' });
  assert.equal(f.isPending('assign:llm'), true);
  for (const key of ['assign:operator', 'attest', 'evaluate:done', 'retry']) assert.equal(f.isPending(key), false);
  await f.command({ action: 'evaluate', stage: 'done' }); assert.equal(f.calls.length, 1);
  response.resolve({ request: record(), duplicate: false }); await running;
  assert.equal(f.isPending('assign:llm'), false);
});

for (const passed of [true, false]) test(`acceptance preserves exact identity and reports actual completion outcome (${passed})`, async t => {
  const current = record();
  const f = fixture(async command => {
    current.revision++;
    current.attestation = { actor: 'operator', inputHash: command.inputHash, outputDigest: command.outputDigest, note: command.note, at };
    current.evaluations[0].passed = passed;
    current.phase = passed ? 'done' : 'needs_rework';
    return { request: current, duplicate: false };
  }); t.after(f.close);
  f.setDraft('attestation', 'Reviewed the recorded result.'); await f.attest();
  assert.equal(f.calls.length, 1);
  assert.deepEqual({ action: f.calls[0].action, revision: f.calls[0].expectedRevision, input: f.calls[0].inputHash, output: f.calls[0].outputDigest }, { action: 'attest', revision: 3, input: 'input-a', output: 'output-a' });
  assert.equal(f.canAttest.value, false);
  assert.equal(f.focused.at(-1), 'request-acceptance-recorded');
  assert.match(f.notice.value, passed ? /checks passed; merge remains separate/ : /Completion still needs attention/);
});

test('uncertain acceptance retains the original action and a retry cannot duplicate intent', async t => {
  let fail = true;
  const f = fixture(async () => { if (fail) throw Error('Connection interrupted'); return { request: record(), duplicate: true }; }); t.after(f.close);
  f.setDraft('attestation', 'Review note'); await f.attest();
  const saved = f.operations.get('request-a'); assert.ok(saved);
  f.setDraft('attestation', 'Changed draft'); await f.attest(); assert.equal(f.calls.length, 1);
  f.props.disabled = true;
  fail = false; await f.send(saved);
  assert.deepEqual(f.calls[0], f.calls[1]); assert.equal(f.operations.size, 0);
  assert.match(f.notice.value, /No duplicate work/);
});


test('stopped-process confirmation binds the run and observation and retries the exact saved command', async t => {
  let fail = true;
  const f = fixture(async () => { if (fail) throw Error('Connection interrupted'); return { request: record(), duplicate: true }; }); t.after(f.close);
  f.view.value.delivery = { id: 'delivery-1', inputRevision: 1, allowedControls: ['confirm_stopped'] };
  await f.deliveryCommand('confirm_stopped'); assert.equal(f.calls.length, 0);
  await f.deliveryCommand('resume', 'Inspected processes'); assert.equal(f.calls.length, 0);
  await f.deliveryCommand('confirm_stopped', '  Inspected the retained workspace and stopped the previous process.  ');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].deliveryRunId, 'delivery-1'); assert.equal(f.calls[0].inputRevision, 1);
  assert.equal(f.calls[0].note, 'Inspected the retained workspace and stopped the previous process.');
  const saved = f.operations.get('request-a'); assert.ok(saved);
  fail = false; await f.send(saved);
  assert.deepEqual(f.calls[0], f.calls[1]);
  assert.equal(f.calls.some(command => command.action === 'resume'), false);
});
