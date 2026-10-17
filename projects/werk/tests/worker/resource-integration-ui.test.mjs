import { normalizeSource } from '../helpers/source-text.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { ref, computed, watch, reactive, effectScope, nextTick } from 'vue';
async function fixture(t, component, request, workspaceAction = async () => true) {
 const source = normalizeSource(await readFile(new URL('../../src/worker/webview/components/' + component + '.vue', import.meta.url), 'utf8'));
 const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import .*;\n/gm, '');
 const state = reactive({ unlocked: true, lastRead: '', settings: null });
 const scope = effectScope(); t.after(() => scope.stop());
 const ports = { ref, computed, watch, state, request, defineProps: () => ({}), onMounted() {}, onActivated() {}, onDeactivated() {}, useRouter: () => ({ push: async () => {} }), workspaceAction };
 const fields = component === 'ProjectIntegrationsPanel' ? 'report, reviewed, preview, apply, load, error' : 'report, loadEvents, history, events, historyOpen';
 return { ...scope.run(() => new Function(...Object.keys(ports), ts.transpile(script, { target: ts.ScriptTarget.ES2022 }) + '\nreturn {' + fields + '};')(...Object.values(ports))), state };
}
const plan = id => ({ enabled: true, planId: id, canApply: true, files: [{ path: '.codex/werk-worker.md', state: 'missing', action: 'create', content: 'Generated project instructions' }] });
test('synchronization applies the explicitly reviewed plan even when status refreshes', async t => {
 const calls = []; const f = await fixture(t, 'ProjectIntegrationsPanel', async (path, method, body) => { calls.push(body); return body?.action === 'plan' ? plan('reviewed') : plan('new-status'); });
 await f.preview(); await f.load(); await f.apply();
 assert.deepEqual(calls.at(-1), { action: 'apply', expectedPlan: 'reviewed' }); assert.equal(f.reviewed.value, null);
});
test('stale synchronization never retries automatically or loses the reviewed protected plan', async t => {
 let attempts = 0; const f = await fixture(t, 'ProjectIntegrationsPanel', async (path, method, body) => { if (body.action === 'plan') return plan('reviewed'); attempts++; throw Object.assign(Error('Project changed'), { status: 409 }); });
 await f.preview(); await f.apply(); assert.equal(attempts, 1); assert.equal(f.reviewed.value.planId, 'reviewed'); assert.match(f.error.value, /fresh plan/);
});
test('access expiry retires an in-flight private project plan', async t => {
 const { promise, resolve: done } = Promise.withResolvers();
 const f = await fixture(t, 'ProjectIntegrationsPanel', () => promise);
 const pending = f.preview(); f.state.unlocked = false; await nextTick(); done(plan('private')); await pending;
 assert.equal(f.report.value, null); assert.equal(f.reviewed.value, null);
});
test('resource history traverses retained events with the returned sequence cursor and reports gaps', async t => {
 const calls = []; const f = await fixture(t, 'ResourceMonitorPanel', async (path, method, body) => { calls.push(body); return calls.length === 1 ? { events: [{ id: 'one' }], nextAfter: 51, hasMore: true, gap: true } : { events: [{ id: 'two' }], nextAfter: 52, hasMore: false, gap: false }; });
 await f.loadEvents(); assert.equal(f.history.value.gap, true); await f.loadEvents(true); assert.equal(calls[1].after, 51); assert.deepEqual(f.events.value.map(event => event.id), ['one', 'two']);
 f.state.unlocked = false; await nextTick(); assert.deepEqual(f.events.value, []); assert.equal(f.history.value, null);
});
