import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providerUsage, codexUsage } from '../../src/worker/dist/worker/infrastructure/provider-usage.js';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { providerCommand } from '../../src/worker/dist/worker/infrastructure/codex-adapter.js';
const messages = [{ id: 'fixture', role: 'user', text: 'Fixture input', state: 'complete', at: '2026-10-14T00:00:00Z' }];
const signal = () => AbortSignal.timeout(5000);
const connection = id => ({ id, model: 'fixture-model', apiKey: 'fixture-secret', executable: '' });

test('provider normalization preserves unknown and measured zero without inventing cost', () => {
  const empty = providerUsage('openai', {});
  assert.equal(empty.source, 'unavailable');
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'providerReportedCostUsd']) assert.equal(empty[key], null);
  const zero = providerUsage('openai', { usage: { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } }, total_cost_usd: 1 });
  assert.equal(zero.source, 'provider_reported'); assert.equal(zero.inputTokens, 0); assert.equal(zero.outputTokens, 0); assert.equal(zero.cacheReadTokens, 0); assert.equal(zero.providerReportedCostUsd, null);
  const invalid = providerUsage('claude', { usage: { input_tokens: '30', output_tokens: -1, cache_read_input_tokens: Infinity, cache_creation_input_tokens: 1.5 }, total_cost_usd: NaN });
  assert.equal(invalid.source, 'unavailable');
  assert.equal(providerUsage('codex', { usage: { input_tokens: 3, cached_input_tokens: 4, output_tokens: 2 } }).cacheReadTokens, null);
});

test('cost provenance distinguishes Claude client estimates from billing and unknown cost', () => {
  for (const reported of [0, 0.012]) {
    const usage = providerUsage('claude', { total_cost_usd: reported });
    assert.equal(usage.providerReportedCostUsd, reported);
    assert.equal(usage.costBasis, 'reported_estimate');
    assert.equal(usage.source, 'provider_reported');
  }
  for (const reported of [undefined, null, -1, Infinity, NaN, '0.012']) {
    const usage = providerUsage('claude', { usage: { output_tokens: 3 }, total_cost_usd: reported });
    assert.equal(usage.providerReportedCostUsd, null);
    assert.equal(usage.costBasis, 'unavailable');
    assert.equal(usage.outputTokens, 3);
  }
  for (const protocol of ['openai', 'anthropic', 'codex']) {
    const usage = providerUsage(protocol, { usage: { output_tokens: 3 }, total_cost_usd: 1, costBasis: 'reported_billed' });
    assert.equal(usage.providerReportedCostUsd, null);
    assert.equal(usage.costBasis, 'unavailable');
  }
  assert.equal(providerUsage('claude', {}).costBasis, 'unavailable');
});

test('Claude crash zeros remain unknown while positive partial usage survives', () => {
  const zero = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
  const crashed = providerUsage('claude', { subtype: 'error_during_execution', usage: zero, total_cost_usd: 0 });
  assert.equal(crashed.source, 'unavailable');
  assert.equal(crashed.inputTokens, null); assert.equal(crashed.outputTokens, null);
  assert.equal(crashed.cacheReadTokens, null); assert.equal(crashed.cacheWriteTokens, null);
  assert.equal(crashed.providerReportedCostUsd, null); assert.equal(crashed.costBasis, 'unavailable');
  const partial = providerUsage('claude', { subtype: 'error_during_execution', usage: { ...zero, output_tokens: 3 }, total_cost_usd: 0 });
  assert.equal(partial.outputTokens, 3); assert.equal(partial.inputTokens, null); assert.equal(partial.providerReportedCostUsd, null);
  const completed = providerUsage('claude', { subtype: 'success', usage: zero, total_cost_usd: 0 });
  assert.equal(completed.inputTokens, 0); assert.equal(completed.outputTokens, 0); assert.equal(completed.providerReportedCostUsd, 0);
  assert.equal(completed.costBasis, 'reported_estimate');
});

test('cache input is a subset of normalized input for every supported protocol', () => {
  assert.equal(providerUsage('codex', { usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 8 } }).inputTokens, 100);
  assert.equal(providerUsage('openai', { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 60 }, output_tokens: 8 } }).inputTokens, 100);
  for (const protocol of ['anthropic', 'claude']) {
    const usage = providerUsage(protocol, { usage: { input_tokens: 40, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 8 }, total_cost_usd: 0.012 });
    assert.equal(usage.inputTokens, 100); assert.equal(usage.cacheReadTokens, 50); assert.equal(usage.cacheWriteTokens, 10);
    assert.equal(usage.providerReportedCostUsd, protocol === 'claude' ? 0.012 : null);
  }
});

test('API usage survives incomplete and HTTP error results without storing response contents', async () => {
  for (const id of ['openai-api', 'anthropic-api']) {
    for (const status of [200, 429]) {
      let usage;
      const model = modelFor(connection(id), '/unused', async () => Response.json({ status: 'incomplete', stop_reason: 'max_tokens', usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, private_diagnostic: 'must-not-be-evidence' }, { status }));
      await assert.rejects(model.reply(messages, signal(), value => { usage = value; }), error => {
        assert.equal(error.name, 'ProviderModelError');
        assert.equal(error.code, status === 200 ? 'incomplete' : 'rate_limit');
        assert.equal(error.status, status === 200 ? undefined : 429);
        return true;
      });
      assert.equal(usage.inputTokens, 12); assert.equal(usage.outputTokens, 5); assert.equal(usage.providerReportedCostUsd, null);
      assert.equal(JSON.stringify(usage).includes('must-not-be-evidence'), false);
    }
    const model = modelFor(connection(id), '/unused', async () => Response.json(id === 'openai-api' ? { status: 'completed', usage: { input_tokens: 6, output_tokens: 2 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Reply' }] }] } : { stop_reason: 'end_turn', usage: { input_tokens: 6, output_tokens: 2 }, content: [{ type: 'text', text: 'Reply' }] }));
    let usage; assert.equal(await model.reply(messages, signal(), value => { usage = value; }), 'Reply'); assert.equal(usage.outputTokens, 2);
  }
});

async function cliFixture(t, output, exitCode = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-provider-usage-')), executable = join(directory, 'provider');
  await writeFile(executable, '#!' + process.execPath + '\nprocess.stdout.write(' + JSON.stringify(output) + ');process.stderr.write("private diagnostic");process.exitCode=' + exitCode + ';\n');
  await chmod(executable, 0o700); t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, executable };
}
const posix = { skip: process.platform === 'win32' };
test('Codex terminal usage survives turn failure and nonzero process exit', posix, async t => {
  for (const exitCode of [0, 7]) {
    const output = [ { type: 'item.completed', item: { type: 'agent_message', text: 'private reply' } }, { type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 8, output_tokens: 4 } }, { type: 'turn.failed', error: { message: 'private diagnostic' } } ].map(JSON.stringify).join('\n');
    const fixture = await cliFixture(t, output, exitCode), model = modelFor({ ...connection('codex-cli'), executable: fixture.executable }, fixture.directory);
    let usage; await assert.rejects(model.reply(messages, signal(), value => { usage = value; }), /Provider/);
    assert.equal(usage.inputTokens, 20); assert.equal(usage.cacheReadTokens, 8); assert.equal(usage.outputTokens, 4);
    assert.equal(JSON.stringify(usage).includes('private'), false);
  }
});
test('Claude reported usage and USD cost survive unsuccessful result and exit', posix, async t => {
  for (const exitCode of [0, 9]) {
    const fixture = await cliFixture(t, JSON.stringify({ type: 'result', is_error: true, result: 'private diagnostic', usage: { input_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 4 }, total_cost_usd: 0.025 }), exitCode);
    const model = modelFor({ ...connection('claude-cli'), executable: fixture.executable }, fixture.directory);
    let usage; await assert.rejects(model.reply(messages, signal(), value => { usage = value; }));
    assert.equal(usage.inputTokens, 10); assert.equal(usage.providerReportedCostUsd, 0.025); assert.equal(JSON.stringify(usage).includes('private'), false);
  }
});
test('Codex ignores non-terminal lookalike usage and accumulates actual completed turns', () => {
  let usage;
  const output = [{ type: 'item.completed', usage: { input_tokens: 999 } }, ...[3, 5].map(input_tokens => ({ type: 'turn.completed', usage: { input_tokens, cached_input_tokens: 1, output_tokens: 2 } }))];
  codexUsage(Buffer.from(output.map(JSON.stringify).join('\n')), value => { usage = value; });
  assert.equal(usage.inputTokens, 8); assert.equal(usage.outputTokens, 4); assert.equal(usage.cacheReadTokens, 2);
});
test('telemetry observer failure cannot alter child success or mask child failure', posix, async t => {
  for (const exitCode of [0, 5]) {
    const fixture = await cliFixture(t, 'bounded fixture', exitCode);
    const execution = providerCommand(fixture.executable, [], fixture.directory, signal(), undefined, true, 'codex', () => { throw Error('observer failure'); });
    if (exitCode) await assert.rejects(execution, { name: 'ProviderModelError', code: 'unavailable' });
    else assert.equal((await execution).toString(), 'bounded fixture');
  }
});

test('an unmeasured Codex turn cannot become a falsely complete invocation total', () => {
  let usage;
  const output = [{ type: 'turn.completed' }, { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } }];
  codexUsage(Buffer.from(output.map(JSON.stringify).join('\n')), value => { usage = value; });
  assert.equal(usage.inputTokens, null); assert.equal(usage.outputTokens, null); assert.equal(usage.source, 'unavailable');
});

test('partial Anthropic input components never masquerade as a measured full input total', () => {
  for (const protocol of ['anthropic', 'claude']) {
    for (const cache of [undefined, -2, Infinity, '4', 0.5]) {
      const usage = providerUsage(protocol, { usage: { input_tokens: 6, output_tokens: 2, cache_read_input_tokens: cache, cache_creation_input_tokens: 0 }, total_cost_usd: 0.01 });
      assert.equal(usage.inputTokens, null); assert.equal(usage.outputTokens, 2); assert.equal(usage.cacheReadTokens, null); assert.equal(usage.cacheWriteTokens, 0); assert.equal(usage.source, 'provider_reported');
      assert.equal(usage.providerReportedCostUsd, protocol === 'claude' ? 0.01 : null);
    }
  }
});
