import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue';
import { frontend } from '../ui/helpers/frontend-loader.mjs';

const { buildTaskOverview } = await frontend('src/worker/webview/task-overview.ts');
const { readRequestSummaries } = await frontend('src/worker/webview/request-summary-reader.ts');
const source = await readFile(new URL('../../src/worker/webview/pages/TaskboardPage.vue', import.meta.url), 'utf8');
const script = source.split('<script setup lang="ts">')[1].split('</script>')[0];
const parsed = ts.createSourceFile('page.ts', script, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const code = ts.createPrinter().printList(ts.ListFormat.MultiLine, ts.factory.createNodeArray(parsed.statements.filter(statement => !ts.isImportDeclaration(statement))), parsed);
const javascript = ts.transpile(code, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS });
const at = '2026-10-18T12:00:00.000Z';
function fixture(t) {
  const calls = [], state = reactive({ unlocked: true, workspaceBusy: false, sessionsReadAt: at, environment: null, board: null, history: null,
    sessions: { selected: '', records: [], execution: { currentSessionId: 'ready-review-one' } } });
  const run = { id: 'review-run', sessionId: 'ready-review-one', title: 'Ready Check: Improve search', purpose: 'gate_review', provider: 'codex-cli', model: 'review-model', startedAt: at, after: null, usage: { inputTokens: 300, outputTokens: 80 } };
  const read = async (path, method, body) => {
    calls.push({ path, method, body });
    if (path === '/api/features') return { enabled: false };
    if (path === '/api/requests') return { schemaVersion: 1, rows: [], total: 0, nextOffset: null };
    return { total: 1, rows: [run] };
  };
  const bindings = { computed, ref, watch, nextTick, onActivated() {}, onDeactivated() {}, useRoute: () => ({ path: '/taskboard', query: {} }), useRouter: () => ({}), state, request: read,
    buildTaskOverview, readRequestSummaries, buildWorkerCapacityView: () => ({ state: 'busy', stale: false }), getCapacityFreshness: () => 'fresh' };
  const scope = effectScope(); t.after(() => scope.stop());
  const result = scope.run(() => new Function(...Object.keys(bindings), javascript + '\nreturn { readEvidence, activeRun, currentExecutionId, currentSession, runProvider, runModel, runElapsed, usage, canStop };')(...Object.values(bindings)));
  return { ...result, state, run, calls };
}

test('Taskboard inspects the executor attempt even without an implementation conversation', async t => {
  const f = fixture(t); await f.readEvidence();
  assert.equal(f.currentSession.value, undefined); assert.equal(f.currentExecutionId.value, 'ready-review-one');
  assert.deepEqual(f.calls[1], { path: '/api/runs', method: 'POST', body: { action: 'list', sessionId: 'ready-review-one', outcome: 'running', limit: 2 } });
  assert.equal(f.activeRun.value.id, 'review-run'); assert.equal(f.runProvider.value, 'codex-cli'); assert.equal(f.runModel.value, 'review-model');
  assert.equal(f.runElapsed.value, '0m 0s elapsed'); assert.equal(f.usage.value, '380 tokens reported');
  assert.equal(f.canStop.value, false);
});

test('a changed executor identity cannot reuse the previous attempt model or usage', async t => {
  const f = fixture(t); await f.readEvidence();
  f.state.sessions.execution.currentSessionId = 'another-review';
  assert.equal(f.runModel.value, 'Not yet recorded'); assert.equal(f.usage.value, 'Token usage unavailable');
  await f.readEvidence(); assert.equal(f.activeRun.value, null);
});
