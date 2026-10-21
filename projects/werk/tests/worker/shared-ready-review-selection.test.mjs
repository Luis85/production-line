import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultDeliveryProjectPolicy, deliveryPolicySnapshot } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { source, sourcePath } from './shared-feature-fixture.mjs';
import { reviewedFixture, passed } from './shared-ready-review-fixture.mjs';

test('accepted shared provider/model/effort survive settings changes, restart, answers and implementation', async t => {
  const defaults = { provider: 'claude-cli', model: 'initial-model', effort: 'high' };
  const f = await reviewedFixture(t, { defaultProvider: () => defaults.provider,
    resolveSelection: input => ({ provider: input.provider, model: input.model ?? defaults.model, effort: input.effort ?? defaults.effort }) });
  await f.intake.sync();
  const selection = { provider: 'claude-cli', model: 'initial-model', effort: 'high' };
  assert.deepEqual(f.inputs[0].selection, selection);
  assert.deepEqual(f.intake.view().requests[0].selection, selection);
  assert.match(f.repositories.get('shared').files.get(sourcePath), /selection:\n\s+provider: claude-cli/);
  Object.assign(defaults, { provider: 'codex-cli', model: 'later-model', effort: 'low' });
  f.finish(); await f.intake.sync(); await f.restart();
  f.answer('Yes, wrap to the first item.'); await f.intake.sync();
  assert.equal(f.inputs.length, 2); assert.equal(f.inputs[1].provider, 'claude-cli');
  assert.deepEqual(f.inputs[1].selection, selection);
  f.finish(passed); await f.intake.sync();
  assert.equal(f.submittedRecords.length, 1); assert.deepEqual(f.submittedRecords[0].selection, selection);
  assert.equal(f.submittedRecords[0].accepted.provider, 'claude-cli');
  await f.restart(); await f.intake.sync(); assert.equal(f.inputs.length, 2); assert.equal(f.submittedRecords.length, 1);
});

test('Ready Check replies cannot change or remove authored model selection after claim', async t => {
  const selected = source.replace('mode: patch', 'provider: codex-cli\nmodel: chosen-model\neffort: high\nmode: patch');
  const f = await reviewedFixture(t, { source: selected,
    resolveSelection: input => ({ provider: input.provider, model: input.model, effort: input.effort }) });
  await f.intake.sync(); f.finish(); await f.intake.sync();
  const original = f.repositories.get('shared').files.get(sourcePath), before = (await f.state()).records[0];
  for (const change of [markdown => markdown.replace('provider: codex-cli', 'provider: claude-cli'), markdown => markdown.replace('model: chosen-model', 'model: changed-model'),
    markdown => markdown.replace('effort: high', 'effort: low'), markdown => markdown.replace('model: chosen-model\n', ''), markdown => markdown.replace('effort: high\n', '')]) {
    f.commitFiles('shared', { [sourcePath]: original });
    f.answer('Yes, wrap to the first item.', change); const edited = f.repositories.get('shared').files.get(sourcePath);
    await f.intake.sync(); assert.equal(f.inputs.length, 1); assert.equal(f.submits.length, 0);
    assert.equal(f.repositories.get('shared').files.get(sourcePath), edited, 'Rejected selection edits remain available for the team to repair.');
    const record = (await f.state()).records[0]; assert.deepEqual(record.selection, before.selection); assert.deepEqual(record.accepted, before.accepted);
    assert.match(record.error, /accepted provider, model and effort unchanged/); await f.restart();
  }
  f.commitFiles('shared', { [sourcePath]: original }); f.answer('Yes, keep the selected model and wrap.');
  await f.intake.sync(); assert.equal(f.inputs.length, 2); assert.deepEqual(f.inputs[1].selection, before.selection);
});

test('an invalid resolved model leaves shared work unclaimed without a reviewer dispatch', async t => {
  const f = await reviewedFixture(t, { resolveSelection: () => ({ provider: 'cursor-cli', model: 'auto', effort: 'high' }) });
  await f.intake.sync(); assert.equal(f.inputs.length, 0); assert.equal((await f.state()).records.length, 0);
  assert.match(f.intake.view().requests[0].error, /supported effort/);
});

test('Ready Check uses the frozen routed provider when the source omitted a provider', async t => {
  const f = await reviewedFixture(t, {
    defaultProvider: () => 'claude-cli',
    resolveSelection: () => ({ provider: 'codex-cli', model: 'accepted-profile-model', effort: 'high', authenticationMode: 'cli-account' }),
  });
  await f.intake.sync();
  assert.equal(f.inputs.length, 1); assert.equal(f.gateCalls(), 0);
  assert.equal((await f.state()).records[0].accepted.provider, 'claude-cli');
  assert.equal(f.inputs[0].provider, 'codex-cli');
  assert.deepEqual(f.inputs[0].selection, { provider: 'codex-cli', model: 'accepted-profile-model', effort: 'high', authenticationMode: 'cli-account' });
  f.finish(passed); await f.intake.sync();
  assert.equal(f.submits.length, 1);
  await f.restart(); await f.intake.sync();
  assert.equal(f.inputs.length, 1); assert.equal(f.submits.length, 1);
});

test('Ready Check input retains the claimed profile definition and exact expanded-policy approval subject', async t => {
  const definition = { definitionId: 'imported', ref: 'team-reviewer', agent: 'root', name: 'Team reviewer', digest: 'b'.repeat(64), instruction: 'Accepted instructions.', model: '', provider: '', adapted: false, unsupported: [] };
  /** @type {import('../../src/worker/application/delivery-execution-policy.js').DeliveryExecutionProfile} */
  const profile = { id: 'primary', provider: 'codex-cli', model: '', effort: 'default', authenticationMode: 'cli-account', boundary: 'worker_grants', definitionRef: 'team-reviewer' };
  const selection = { provider: 'codex-cli', model: '', effort: 'default', authenticationMode: 'cli-account' };
  /** @type {import('../../src/worker/application/delivery-execution-policy.js').DeliveryExecutionPolicy} */
  const execution = { profiles: [profile], defaultProfile: 'primary', allowedOverrides: [], fallbackProfiles: [], fallbackOn: [], maxHandoffs: 0 };
  const configuration = { ...defaultDeliveryProjectPolicy(), execution };
  const f = await reviewedFixture(t, { prepare: (_input, _binding, commit) => ({ selection, deliveryPolicy: deliveryPolicySnapshot(configuration, commit), deliveryExecution: { policy: execution, resolution: { profile, source: 'default' }, selection, definition, profileSnapshots: [{ profileId: 'primary', selection, definition }] } }) });
  await f.intake.sync(); const record = (await f.state()).records[0]; assert.equal(f.inputs.length, 1);
  assert.deepEqual(f.inputs[0].definition, definition); assert.deepEqual(f.inputs[0].deliveryAuthority, { repositoryId: 'shared', configurationDigest: record.deliveryPolicy.configurationDigest });
  definition.instruction = 'A later import changes instructions.';
  f.finish(); await f.intake.sync(); f.answer('Use the original accepted reviewer.'); await f.intake.sync();
  assert.equal(f.inputs[1].definition.instruction, 'Accepted instructions.'); assert.deepEqual(f.inputs[1].deliveryAuthority, f.inputs[0].deliveryAuthority);
  await f.restart(); await f.intake.sync(); assert.equal(f.inputs.length, 2);
});

test('Ready Check answers cannot replace the accepted execution profile or agent definition selectors', async t => {
  const selected = source.replace('mode: patch', 'provider: codex-cli\nexecution_profile: primary\ndefinitionRef: team-agent\nagent: root\nuseInstructionsOnly: false\nmode: patch');
  const f = await reviewedFixture(t, { source: selected, resolveSelection: () => ({ provider: 'codex-cli', model: '', effort: 'default' }) });
  await f.intake.sync(); f.finish(); await f.intake.sync(); const original = f.repositories.get('shared').files.get(sourcePath), before = (await f.state()).records[0];
  for (const change of [markdown => markdown.replace('execution_profile: primary', 'execution_profile: other'), markdown => markdown.replace('definitionRef: team-agent', 'definitionRef: other-agent'), markdown => markdown.replace('agent: root', 'agent: other'), markdown => markdown.replace('useInstructionsOnly: false', 'useInstructionsOnly: true')]) {
    f.commitFiles('shared', { [sourcePath]: original }); f.answer('Updated requirements.', change); await f.intake.sync();
    assert.equal(f.inputs.length, 1); assert.equal(f.submits.length, 0); assert.deepEqual((await f.state()).records[0].accepted, before.accepted);
    assert.match((await f.state()).records[0].error, /agent definition/);
  }
});
