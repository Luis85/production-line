import { prepareProcessRuntime } from '../../src/worker/dist/shared/process/launcher.js';
import { defaultExecutionPolicy } from '../../src/worker/dist/worker/application/execution-policy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { workspaceModelFactory } from '../../src/worker/dist/worker/infrastructure/workspace-services.js';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { FileConversationStore } from '../../src/worker/dist/worker/infrastructure/conversation.js';
import { WorkerConversation } from '../../src/worker/dist/worker/application/conversation.js';
import { WorkerRunJournal } from '../../src/worker/dist/worker/infrastructure/journal/local-runs.js';
import { WorkerInteractionJournal } from '../../src/worker/dist/worker/infrastructure/journal/interactions.js';
import { defaultToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { interactionFeatureRequest } from '../../src/worker/dist/worker/application/feature-request-reference.js';
import { prepareModelRequest, executeModel } from '../../src/worker/dist/worker/application/model-contract.js';
import { sessionHistoryTool } from '../../src/worker/dist/worker/infrastructure/session-history-tool.js';
import { sessionDigest } from '../../src/worker/dist/worker/application/model-session.js';
/** @type {import('../../src/worker/application/provider-contract.ts').ProviderConnection} */
const connection = { id: 'openai-api', model: 'fixture', effort: 'high', instruction: 'Frozen original profile', executable: '', apiKey: 'fixture-only' };
const output = text => Response.json({ status: 'completed', usage: { input_tokens: 5, output_tokens: 2 }, output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
async function fixture(t, { prepareRuntime = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-session-integration-')); const runs = new WorkerRunJournal(directory), interactions = new WorkerInteractionJournal(directory);
  await runs.init(); await interactions.init(); t.after(async () => { runs.close(); interactions.close(); await rm(directory, { recursive: true, force: true }); });
  // Added history/delegation operations conservatively require native readiness before the completion poll.
  if (prepareRuntime) await prepareProcessRuntime(directory, t.signal);
  const policy = defaultToolPolicy(), settings = { toolPolicy: () => policy, value: { execution: { ...defaultExecutionPolicy(), maxRuntimeMs: 30000, maxToolCalls: 32, commandTimeoutMs: 1000 }, repositories: { pollMs: 30000, items: [] } } };
  const scope = { sessionId: 'same-fr', feature: interactionFeatureRequest('same-fr') };
  return { directory, runs, interactions, policy, settings, scope };
}
async function settled(chat) {
  for (let n = 0; chat.snapshot().busy && n < 1000; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(chat.snapshot().busy, false); assert.equal(chat.snapshot().persistenceError, false);
  assert.equal(chat.snapshot().messages.at(-1).state, 'complete');
}
test('one FR continues beyond sixty messages, restarts, and retrieves original decisions from the private history', async t => {
  const f = await fixture(t, { prepareRuntime: true }); let calls = 0;
  const factory = workspaceModelFactory(f.directory, f.settings, (saved, directory, _transport, options) => modelFor(saved, directory, async () => output('Completed turn ' + ++calls), options), undefined, f.runs);
  const model = /** @type {import('../../src/worker/application/model-contract.ts').StructuredModel} */ (factory(connection, f.scope));
  const create = () => new WorkerConversation(new FileConversationStore(f.directory), model, 30000, undefined, f.scope.sessionId, { journal: f.runs, interactions: f.interactions, feature: () => f.scope.feature, metadata: () => ({ sessionId: f.scope.sessionId, taskId: 'same-fr', title: 'One persistent FR', kind: 'chat', provider: connection.id, model: connection.model }) });
  let chat = create(); await chat.init();
  for (let n = 0; n < 36; n++) { await chat.start('Keep decision ' + n); await settled(chat); }
  assert.equal(calls, 36); assert.ok(chat.snapshot().messages.length < 60); assert.equal(chat.snapshot().messages[0].text, 'Keep decision 0');
  await chat.close(); chat = create(); await chat.init(); await chat.start('Continue this same request after restart'); await settled(chat);
  assert.equal(calls, 37); assert.equal(f.interactions.view(f.scope.sessionId).totalTurns, 37);
  const first = f.interactions.view(f.scope.sessionId).turns.at(-1);
  const history = sessionHistoryTool(f.directory, model.sessionBinding), result = await history.call({ turnId: first.id }, new AbortController().signal);
  assert.match(result.content[0].text, /Keep decision 0/); await chat.close();
});
test('composition delegates from the frozen parent profile, links numeric child evidence, and persists private receipts', async t => {
  const f = await fixture(t, { prepareRuntime: true }); f.policy.delegation = { enabled: true, maxChildren: 4, maxConcurrent: 2 };
  const childProfiles = []; let parentCalls = 0;
  const factory = workspaceModelFactory(f.directory, f.settings, (saved, directory, _transport, options) => {
    const child = options?.session?.binding.logicalSessionId.startsWith('delegated-'); if (child) childProfiles.push(saved);
    return modelFor(saved, directory, async () => {
      if (child) return output('Child result');
      if (parentCalls++ === 0) return Response.json({ status: 'completed', usage: { input_tokens: 2, output_tokens: 1 }, output: [{ type: 'function_call', call_id: 'delegate-call', name: 'werk_delegate', arguments: JSON.stringify({ tasks: [{ id: 'inspect', prompt: 'Inspect within the same accepted feature scope', tools: [] }] }) }] });
      return output('Parent complete');
    }, options);
  }, undefined, f.runs);
  const preparedModel = factory(connection, f.scope), request = prepareModelRequest(preparedModel, [{ id: 'original', role: 'user', state: 'complete', at: '2026-10-19T00:00:00Z', text: 'Inspect this feature' }]);
  const parent = await f.runs.begin({ sessionId: f.scope.sessionId, taskId: 'same-fr', title: 'One FR', kind: 'local', provider: connection.id, model: connection.model }); await f.runs.start(parent.id);
  const currentModel = factory({ ...connection, effort: 'low', instruction: 'Later changed global profile' }, f.scope);
  assert.equal((await executeModel(currentModel, request, new AbortController().signal)).type, 'completed');
  assert.equal(childProfiles.length, 1); assert.equal(childProfiles[0].instruction, connection.instruction); assert.equal(childProfiles[0].effort, 'high');
  const child = f.runs.list().rows.find(row => row.parentRunId === parent.id); assert.ok(child); assert.equal(child.outcome, 'completed'); assert.equal(child.parentSessionId, f.scope.sessionId);
  const receiptDirectory = join(f.directory, 'model-sessions', 'delegation', sessionDigest(request.session)), files = await readdir(receiptDirectory);
  assert.equal(files.length, 1); const receipt = JSON.parse(await readFile(join(receiptDirectory, files[0]), 'utf8'));
  assert.equal(receipt.binding.featureRequestKey, f.scope.feature.key); assert.equal(receipt.parentRunId, parent.id); assert.equal(receipt.receipt.state, 'completed');
  assert.equal(receipt.receipt.result.text, 'Child result');
  const history = sessionHistoryTool(f.directory, request.session), listing = JSON.parse((await history.call({ receipts: true }, new AbortController().signal)).content[0].text);
  assert.equal(listing.receipts.length, 1);
  const saved = JSON.parse((await history.call({ receiptId: listing.receipts[0].receiptId }, new AbortController().signal)).content[0].text);
  assert.match(saved.text, /Child result/);
  await assert.rejects(history.call({ receiptId: '../private' }, new AbortController().signal));
});


test('Cursor retains history access without advertising worker-bounded native delegation', async t => {
  const f = await fixture(t); f.policy.delegation = { enabled: true, maxChildren: 4, maxConcurrent: 2 };
  const factory = workspaceModelFactory(f.directory, f.settings, modelFor, undefined, f.runs);
  const model = factory({ id: 'cursor-cli', model: 'auto', effort: 'default', executable: '/fixture/agent', apiKey: '' }, f.scope);
  const request = prepareModelRequest(model, [{ id: 'original', role: 'user', state: 'complete', at: '2026-10-18T00:00:00Z', text: 'Inspect this feature' }]);
  assert.equal(request.policy.tools, 'provider_native');
  assert.ok(request.toolManifest.tools.some(tool => tool.name === 'werk_session_history'));
  assert.ok(!request.toolManifest.tools.some(tool => tool.name === 'werk_delegate'));
  assert.match(request.protocolInstructions, /Cursor permissions/);
  assert.equal(f.runs.list().rows.length, 0, 'metadata inspection cannot launch a provider or native child');
});
