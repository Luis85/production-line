import test from 'node:test';
import assert from 'node:assert/strict';
import { frontend } from '../helpers/frontend-loader.mjs';
const { assignmentModeLabel, supportsLocalRequestSetup, hasRequestActivity } = await frontend('src/worker/webview/worker-mode-view.ts');
test('standalone local providers never inherit an unconfigured fleet assignment mode', () => {
  assert.equal(assignmentModeLabel(null, 'mock'), null);
  assert.equal(assignmentModeLabel(undefined, 'cli'), null);
  assert.equal(assignmentModeLabel('', undefined), null);
  assert.equal(supportsLocalRequestSetup({ orchestratorUrl: null, chat: { configured: false } }, 'standalone'), true, 'first use must remain navigable before a local provider is ready');
});
test('configured fleet simulation remains explicit and local request guidance follows its own availability', () => {
  assert.equal(assignmentModeLabel('http://orchestrator.test', 'mock'), 'Assignments: simulation');
  assert.equal(assignmentModeLabel('http://orchestrator.test', 'cli'), 'Assignments: live Codex');
  assert.equal(supportsLocalRequestSetup({ orchestratorUrl: 'http://orchestrator.test', chat: { configured: true } }, 'idle'), true);
  assert.equal(supportsLocalRequestSetup({ orchestratorUrl: 'http://orchestrator.test', chat: { configured: false } }, 'idle'), false);
  assert.equal(supportsLocalRequestSetup(null, 'standalone'), false);
});

function firstUse() {
  const item = { id: 'session:default', sessionId: 'default', taskId: 'default', source: 'chat', status: 'draft', modelSnapshot: null };
  const session = { id: 'default', taskId: 'default', kind: 'chat', title: 'New task', status: 'draft', messages: 0, busy: false, interaction: { totalTurns: 0, latestTurn: null, pending: null } };
  return { item, session };
}
test('first-use setup ignores only the untouched default conversation and preserves genuine drafts', () => {
  const { item, session } = firstUse();
  assert.equal(hasRequestActivity([item], [session]), false);
  assert.equal(hasRequestActivity([{ ...item, id: 'session:authored', sessionId: 'authored', taskId: 'authored' }], [{ ...session, id: 'authored', taskId: 'authored' }]), true);
  assert.equal(hasRequestActivity([item], [{ ...session, title: 'Plan the release' }]), true);
  assert.equal(hasRequestActivity([item], undefined), true, 'missing session evidence cannot establish an untouched placeholder');
});
test('default conversation with request, run, messages or interaction history counts as activity', () => {
  const { item, session } = firstUse();
  assert.equal(hasRequestActivity([{ ...item, requestId: 'request-default' }], [session]), true);
  assert.equal(hasRequestActivity([{ ...item, deliveryRunId: 'delivery-default' }], [session]), true);
  assert.equal(hasRequestActivity([item], [{ ...session, messages: 1 }]), true);
  assert.equal(hasRequestActivity([item], [{ ...session, interaction: { ...session.interaction, totalTurns: 1 } }]), true);
  assert.equal(hasRequestActivity([item], [{ ...session, busy: true }]), true);
});
