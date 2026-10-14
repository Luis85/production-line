import { normalizeSource } from '../helpers/source-text.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { computed, ref, watch, nextTick, reactive, effectScope } from 'vue';
async function fixture(t, request) {
  const source = normalizeSource(await readFile(new URL('../../src/worker/webview/components/RunEvidencePanel.vue', import.meta.url), 'utf8'));
  const script = source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\n/gm, '');
  const state = reactive({ unlocked: true }), route = reactive({ path: '/history', query: {} }), downloads = [];
  const ports = { computed, ref, watch, nextTick, state, request, useRoute: () => route, defineProps: () => ({ compact: false }), onMounted() {}, onActivated() {}, onDeactivated() {}, document: { createElement: () => ({ click() {} }), getElementById: () => ({ focus() {} }) }, URL: { createObjectURL: blob => { downloads.push(blob.parts); return 'fixture'; }, revokeObjectURL() {} }, Blob: class { constructor(parts) { this.parts = parts; } }, setTimeout() {} };
  const scope = effectScope(); t.after(() => scope.stop());
  const result = scope.run(() => new Function(...Object.keys(ports), ts.transpile(script, { target: ts.ScriptTarget.ES2022 }) + '\nreturn { page, query, analysis, load, exportRuns, exported, exporting, selected, error };')(...Object.values(ports)));
  return { ...result, state, route, downloads };
}
test('run export follows every stable cursor and retains the original filter and admission watermark', async t => {
  const calls = [];
  const f = await fixture(t, async (path, method, body) => { calls.push(body); return body.cursor ? { rows: Array.from({ length: 20 }, (_, index) => ({ id: 'older-' + index })), nextCursor: null } : { rows: Array.from({ length: 100 }, (_, index) => ({ id: 'newer-' + index })), nextCursor: 'next-page' }; });
  f.query.value = { provider: 'codex-cli', sessionId: 'selected-task' }; f.page.value = { rows: [], total: 120, asOf: 42 }; f.analysis.value = { total: 120 };
  await f.exportRuns();
  assert.equal(calls.length, 2); assert.ok(calls.every(body => body.action === 'export' && body.provider === 'codex-cli' && body.sessionId === 'selected-task'));
  assert.equal(calls[0].asOf, 42); assert.equal(calls[1].asOf, undefined); assert.equal(calls[1].cursor, 'next-page'); assert.equal(f.exported.value, 120);
  const exported = JSON.parse(f.downloads[0][0]); assert.equal(exported.rows.length, 120); assert.equal(exported.rows[0].id, 'newer-0'); assert.equal(exported.rows[100].id, 'older-0');
});
test('access expiry clears retained private run evidence and prevents an in-flight export download', async t => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const f = await fixture(t, async () => pending);
  f.page.value = { rows: [{ id: 'private' }], total: 1, asOf: 7 }; f.analysis.value = { total: 1 }; f.selected.value = { id: 'private' };
  const exporting = f.exportRuns(); f.state.unlocked = false; await nextTick(); resolve({ rows: [{ id: 'private' }], nextCursor: null }); await exporting;
  assert.equal(f.page.value, null); assert.equal(f.selected.value, null); assert.equal(f.analysis.value, null); assert.equal(f.downloads.length, 0);
});
test('failed evidence refresh keeps previously loaded values and exposes a retry message', async t => {
  const f = await fixture(t, async () => { throw Error('Evidence unavailable'); });
  f.page.value = { rows: [{ id: 'existing' }], total: 1, asOf: 7 };
  await f.load(); assert.equal(f.page.value.rows[0].id, 'existing'); assert.match(f.error.value, /Evidence unavailable/);
});

test('task-scoped navigation discards a slow prior task response and loads the latest task', async t => {
  let resolveA; const pendingA = new Promise(done => { resolveA = done; });
  const f = await fixture(t, async (path, method, body) => body.action === 'analyze' ? { total: 1 } : body.sessionId === 'A' ? pendingA : { rows: [{ id: 'B' }], total: 1, asOf: 2, nextCursor: null });
  f.route.query.runSession = 'A'; await nextTick();
  f.route.query.runSession = 'B'; await nextTick(); await nextTick(); await nextTick();
  resolveA({ rows: [{ id: 'A' }], total: 1, asOf: 1, nextCursor: null }); await nextTick(); await nextTick();
  assert.equal(f.page.value.rows[0].id, 'B'); assert.equal(f.query.value.sessionId, 'B');
});
