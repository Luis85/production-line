import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { reactive, ref, computed, watch, nextTick, toRefs } from 'vue';

// Exercise the actual editor script with its worker port injected; no DOM renderer or provider calls.
async function editorFixture(action) {
  const source = await readFile(new URL('../../src/worker/webview/components/RunTask.vue', import.meta.url), 'utf8');
  const scripts = [...source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1].replace(/^import .*;\n/gm, '')).join('\n');
  const state = reactive({ draftEpoch: 0, unlocked: true, draft: 'Original chat instructions', actionError: '', settings: { providers: [{ id: 'codex-cli', configured: true }, { id: 'claude-cli', configured: true }] }, sessions: { selected: 'one', records: [{ id: 'one', provider: 'codex-cli' }, { id: 'two', provider: 'claude-cli' }] }, definitions: [] });
  const javascript = ts.transpile(scripts, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS });
  const instantiate = new Function('reactive', 'ref', 'computed', 'watch', 'watchDraftEpoch', 'nextTick', 'toRefs', 'state', 'workerState', 'workspaceAction', 'document', `${javascript}\nreturn { editor, toggleEditor, run, canSubmit, error, submitted };`);
  const result = instantiate(reactive, ref, computed, watch, watch, nextTick, toRefs, state, state, action, { getElementById: () => null });
  await result.toggleEditor();
  Object.assign(result.editor, { title: 'Change', repository: '/project', paths: 'src/a.ts' });
  return { ...result, state };
}

test('file-task instructions and provider survive task switching and expiry, while explicit Lock clears them', async () => {
  const fixture = await editorFixture(async () => ({}));
  assert.equal(fixture.editor.instruction, 'Original chat instructions');
  fixture.state.sessions.selected = 'two'; fixture.state.draft = 'Other task draft';
  assert.equal(fixture.editor.provider, 'codex-cli');
  assert.equal(fixture.editor.instruction, 'Original chat instructions');
  fixture.state.unlocked = false; await nextTick();
  assert.equal(fixture.editor.repository, '/project');
  assert.equal(fixture.editor.instruction, 'Original chat instructions');
  assert.equal(fixture.canSubmit.value, false);
  fixture.state.draftEpoch++;
  assert.equal(fixture.editor.instruction, ''); assert.equal(fixture.editor.repository, ''); assert.equal(fixture.editor.open, false);
});

test('file-task submission guards duplicates and preserves the independent chat draft', async () => {
  const calls = []; let release;
  const fixture = await editorFixture((path, body) => { calls.push({ path, body }); return new Promise(resolve => { release = resolve; }); });
  const pending = fixture.run(); await fixture.run();
  assert.equal(calls.length, 1); assert.equal(calls[0].body.provider, 'codex-cli');
  assert.equal(calls[0].body.instruction, 'Original chat instructions');
  release({ tasks: [] }); await pending;
  assert.equal(fixture.state.draft, 'Original chat instructions');
  assert.equal(fixture.editor.instruction, ''); assert.equal(fixture.submitted.value, true);
});

test('file-task provider mismatches and missing adaptation block submission; failures retain inputs', async () => {
  let calls = 0;
  const fixture = await editorFixture(async () => { calls++; fixture.state.actionError = 'Queue is full'; return undefined; });
  fixture.state.definitions = [{ id: 'agent', agents: [{ name: 'root', provider: 'anthropic', requiresAdaptation: true }] }];
  fixture.editor.definitionId = 'agent'; await nextTick();
  await fixture.run(); assert.equal(calls, 0);
  fixture.editor.provider = 'claude-cli'; await fixture.run(); assert.equal(calls, 0);
  fixture.editor.adapt = true; await fixture.run();
  assert.equal(calls, 1); assert.equal(fixture.error.value, 'Queue is full');
  assert.equal(fixture.editor.instruction, 'Original chat instructions'); assert.equal(fixture.editor.repository, '/project');
});
