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
function fixture(t, sharedRequests = []) {
  const calls = [], state = reactive({ unlocked: true, workspaceBusy: false, sessionsReadAt: at, environment: { sharedIntake: { requests: sharedRequests } }, board: null, history: null,
    sessions: { selected: '', records: [], execution: { currentSessionId: 'ready-review-one', activeSessions: /** @type {import('../../src/worker/application/serial-executor').ActiveExecutionPermit[] | undefined} */ (undefined) } } });
  const run = { id: 'review-run', sessionId: 'ready-review-one', title: 'Ready Check: Improve search', purpose: 'gate_review', provider: 'codex-cli', model: 'review-model', outcome: 'running', acceptedAt: at, startedAt: at, after: null, usage: { inputTokens: 300, outputTokens: 80 } };
  const runs = [run];
  const read = async (path, method, body) => {
    calls.push({ path, method, body });
    if (path === '/api/features') return { enabled: false };
    if (path === '/api/requests') return { schemaVersion: 1, rows: [], total: 0, nextOffset: null };
    return { total: runs.length, rows: runs };
  };
  const bindings = { computed, ref, watch, nextTick, onActivated() {}, onDeactivated() {}, useRoute: () => ({ path: '/taskboard', query: {} }), useRouter: () => ({}), state, request: read,
    buildTaskOverview, readRequestSummaries, buildWorkerCapacityView: () => ({ state: 'busy', stale: false }), getCapacityFreshness: () => 'fresh' };
  const scope = effectScope(); t.after(() => scope.stop());
  const result = scope.run(() => new Function(...Object.keys(bindings), javascript + '\nreturn { readEvidence, activeRun, activeRuns, currentExecutionId, currentSession, runProvider, runModel, runElapsed, usage, canStop, running, extraRunning, activePurpose };')(...Object.values(bindings)));
  return { ...result, state, run, runs, calls };
}

test('Taskboard inspects the executor attempt even without an implementation conversation', async t => {
  const f = fixture(t); await f.readEvidence();
  assert.equal(f.currentSession.value, undefined); assert.equal(f.currentExecutionId.value, 'ready-review-one');
  assert.deepEqual(f.calls[1], { path: '/api/runs', method: 'POST', body: { action: 'list', outcome: 'running', limit: 100 } });
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

test('concurrent attempt projection selects only unique live sessions and never borrows another project model', async t => {
  const f = fixture(t);
  f.state.sessions.execution.activeSessions = ['ready-review-one', 'implementation-two'].map(sessionId => ({ sessionId, projectId: sessionId, projectLimit: 1, startedAt: Date.parse(at), monotonicStartedAt: 0 }));
  f.runs.unshift({ ...f.run, id: 'unrelated', sessionId: 'not-active', model: 'unrelated-model' });
  f.runs.push({ ...f.run, id: 'implementation-run', sessionId: 'implementation-two', model: 'second-model', usage: { inputTokens: 10, outputTokens: 20 } });
  await f.readEvidence(); assert.deepEqual(f.activeRuns.value.map(run => run.id), ['review-run', 'implementation-run']); assert.equal(f.runModel.value, 'review-model');
  f.state.sessions.execution.currentSessionId = 'implementation-two'; assert.equal(f.runModel.value, 'second-model'); assert.equal(f.usage.value, '30 tokens reported');
  f.runs.push({ ...f.runs.at(-1), id: 'ambiguous-second-attempt' }); await f.readEvidence(); assert.equal(f.activeRun.value, null); assert.equal(f.runModel.value, 'Not yet recorded'); assert.deepEqual(f.activeRuns.value.map(run => run.id), ['review-run']);
});


test('Ready Check sessions identify the current reviewer without duplicating it or claiming unrelated attempts', async t => {
  const requests = ['one', 'two'].map(id => ({ id, name: id + '.md', title: 'Review ' + id, status: 'reviewing_ready', isLocal: true, taskId: null, updatedAt: at,
    readyReview: { status: 'running', sessionId: 'ready-review-' + id, runId: id === 'one' ? 'review-run' : 'review-two' } }));
  const f = fixture(t, requests);
  f.state.sessions.execution.activeSessions = ['ready-review-one', 'ready-review-two'].map(sessionId => ({ sessionId, projectId: sessionId, projectLimit: 1, startedAt: Date.parse(at), monotonicStartedAt: 0 }));
  f.runs.push({ ...f.run, id: 'review-two', sessionId: 'ready-review-two', model: 'other-review-model' });
  await f.readEvidence();
  assert.equal(f.activePurpose.value, 'Feature Request Ready Check');
  assert.equal(f.running.value.title, 'Review one'); assert.equal(f.running.value.primaryAction.kind, 'feature');
  assert.deepEqual(f.extraRunning.value.map(item => item.sessionId), ['ready-review-two']);
  assert.equal(f.canStop.value, false); assert.equal(f.currentSession.value, undefined);
  f.run.id = 'previous-attempt'; await f.readEvidence();
  assert.equal(f.running.value, undefined); assert.equal(f.activePurpose.value, 'Advisory review');
  assert.deepEqual(f.extraRunning.value.map(item => item.sessionId), ['ready-review-two']);
});
