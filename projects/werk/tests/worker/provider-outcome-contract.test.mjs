import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { providerCommand } from '../../src/worker/dist/worker/infrastructure/provider-process.js';
import { structuredProviderFailure, cliFailure } from '../../src/worker/dist/worker/infrastructure/provider-failures.js';
import { providerFailureOutcome } from '../../src/worker/dist/worker/application/provider-outcome.js';
import { ProviderModelError, parseModelResult } from '../../src/worker/dist/worker/application/model-result.js';

const formats = {
  codex: code => ({ type: 'turn.failed', error: { code, message: 'private provider details' } }),
  claude: code => ({ type: 'result', is_error: true, error: code, result: 'private provider details' }),
  cursor: code => ({ type: 'error', error: { type: code, message: 'private provider details' } }),
};
async function directory(t) { const root = await mkdtemp(join(tmpdir(), 'werk-provider-outcomes-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

for (const provider of /** @type {const} */ (['codex', 'claude', 'cursor'])) {
  test(`${provider} common CLI boundary normalizes structured failure codes without exposing diagnostics or retrying`, async t => {
    const root = await directory(t), counter = join(root, 'calls');
    for (const [code, state] of [['authentication_error', 'authentication_required'], ['rate_limit_error', 'rate_limited'], ['insufficient_quota', 'quota_exhausted'], ['permission_denied', 'approval_required']]) {
      const value = formats[provider](code), script = `require('node:fs').appendFileSync(${JSON.stringify(counter)},'x');console.log(${JSON.stringify(JSON.stringify(value))});console.error('private credential');process.exitCode=1;`;
      await assert.rejects(providerCommand(process.execPath, ['-e', script], root, t.signal, undefined, true, provider), error => {
        const outcome = providerFailureOutcome(error); assert.equal(outcome.state, state); assert.equal(outcome.automaticRetry, false);
        assert.doesNotMatch(JSON.stringify(outcome), /private provider|private credential/); return true;
      });
    }
    assert.equal(await readFile(counter, 'utf8'), 'xxxx');
    const success = await providerCommand(process.execPath, ['-e', `process.stdout.write('Implemented fixture')`], root, t.signal, undefined, true, provider);
    assert.equal(parseModelResult(success.toString()).type, 'completed');
    assert.equal(parseModelResult(JSON.stringify({ werkInteraction: { schemaVersion: 1, kind: 'question', message: 'Which target?' } })).type, 'needs_input');
  });

  test(`${provider} cancellation stays pending until the contained process exits`, { timeout: 10000 }, async t => {
    const root = await directory(t), started = join(root, 'started'), controller = new AbortController();
    const pending = providerCommand(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(started)},String(process.pid));setInterval(()=>{},1000);`], root, controller.signal, undefined, true, provider);
    const rejected = assert.rejects(pending, error => { assert.equal(providerFailureOutcome(error).state, 'interrupted'); return true; });
    let pid;
    while (!pid) { t.signal.throwIfAborted(); pid = Number(await readFile(started, 'utf8').catch(() => '')); if (!pid) await delay(10); }
    controller.abort(); await rejected;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });
}

test('unknown diagnostic text stays generic and model prose cannot manufacture approval/auth state', () => {
  assert.equal(cliFailure(Buffer.from('authentication_error private-key')).code, 'unavailable');
  assert.equal(structuredProviderFailure({ type: 'result', is_error: false, result: 'authentication_error' }), undefined);
  assert.equal(structuredProviderFailure({ type: 'item.completed', item: { type: 'agent_message', text: 'permission_denied' } }), undefined);
  assert.equal(structuredProviderFailure({ type: 'result', is_error: false, permission_denials: [{ tool_name: 'Bash', tool_input: 'private' }] }).code, 'approval_required');
  assert.equal(providerFailureOutcome(Object.assign(new ProviderModelError('authentication'), { message: 'private diagnostic' })).message, 'Provider authentication failed. Check the saved connection.');
});
