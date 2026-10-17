import { resultWith, workspaceFixture, sharedInput } from './contract-fixtures.mjs';
import { testErrorCode, testErrorMessage } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), 'werk-reference-admission-'));
  const workspace = await workspaceFixture(t, path);
  await workspace.init();
  t.after(async () => { await workspace.close(); await rm(path, { recursive: true, force: true }); });
  await workspace.updateSettings({ provider: { id: 'openai-api', apiKey: 'fixture-no-model-call', model: 'fixture-model' }, board: { paused: true } });
  return workspace;
}

test('task replay still rejects ambiguous profile selectors after the shared reference moves', async t => {
  const workspace = await fixture(t);
  const yaml = 'agents:\n  root:\n    model: openai/gpt-test\n    instruction: Review the request.\n';
  const { definitions: [first] } = resultWith(await workspace.definitions.action({ action: 'import', name: 'First', ref: 'team-reviewer', yaml }), 'definitions');
  const command = { action: 'create', id: 'profile-replay', title: 'Review', provider: 'openai-api', message: 'Review this request.', definitionRef: 'team-reviewer' };
  const initial = resultWith(await workspace.task(command), 'chat');
  const { definitions: [, second] } = resultWith(await workspace.definitions.action({ action: 'import', name: 'Second', yaml }), 'definitions');
  await workspace.definitions.action({ action: 'ref', id: second.id, ref: 'team-reviewer' });
  await assert.rejects(workspace.task({ ...command, definitionId: second.id }), error => testErrorCode(error) === 'invalid_input' && /not both/.test(testErrorMessage(error)));
  const replay = resultWith(await workspace.task(command), 'chat');
  assert.equal(replay.session.definition.definitionId, first.id);
  assert.equal(replay.chat.messages.length, initial.chat.messages.length);
  await workspace.task({ action: 'cancel', id: command.id });
});

test('shared-intake preclaim checks provider compatibility as well as reference and selected agent', async t => {
  const workspace = await fixture(t);
  await workspace.definitions.action({ action: 'import', name: 'Claude reviewer', ref: 'team-reviewer', yaml: 'agents:\n  root:\n    model: anthropic/claude-test\n    instruction: Review the request.\n' });
  // Exercise the actual composition callback handed to shared intake. No repository
  // or provider call is needed to reject an incompatible selection before claiming.
  // @ts-expect-error Inspect the private composition callback to verify preclaim admission.
  const admissionIssue = workspace.sharedRuntime.intake.ports.admissionIssue;
  assert.match(admissionIssue(sharedInput({ provider: 'codex-cli', definitionRef: 'team-reviewer' })), /matching worker provider/);
  assert.equal(admissionIssue(sharedInput({ provider: 'claude-cli', definitionRef: 'team-reviewer' })), undefined);
  assert.match(admissionIssue(sharedInput({ provider: 'claude-cli', definitionRef: 'missing-reviewer' })), /No agent definition/);
  assert.match(admissionIssue(sharedInput({ provider: 'claude-cli', definitionRef: 'team-reviewer', agent: 'missing' })), /Choose an agent/);
});
