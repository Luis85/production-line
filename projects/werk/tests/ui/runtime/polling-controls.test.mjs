import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { computed, ref, watch, nextTick, reactive, effectScope, proxyRefs } from 'vue';
import { deferred } from '../helpers/frontend-loader.mjs';

// Exercise each component's real setup and button bindings with held transport responses.
// Browser polling journeys separately check the rendered icons, labels and dimensions.
async function fixture(t, component, request) {
  const source = await readFile(new URL('../../../src/worker/webview/components/' + component + '.vue', import.meta.url), 'utf8');
  const script = source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\n/gm, '');
  const state = reactive({ unlocked: true, refreshRevision: 0 }), route = reactive({ path: '/history', query: {} });
  const ports = { computed, ref, watch, nextTick, state, request, useRoute: () => route, useRouter: () => ({}), defineProps: () => ({ compact: false }), onMounted() {}, onActivated() {}, onDeactivated() {}, document: { getElementById: () => ({ focus() {} }) } };
  const fields = component === 'FeatureRequestsPanel' ? 'folder, loading, refreshing, error, load' : component === 'RunEvidencePanel' ? 'page, analysis, loading, pendingRead, provider, error, load' : 'report, reviewed, loading, previewing, applying, error, load, preview, apply';
  const scope = effectScope(); t.after(() => scope.stop());
  const values = scope.run(() => new Function(...Object.keys(ports), ts.transpile(script, { target: ts.ScriptTarget.ES2022 }) + '\nreturn {' + fields + '};')(...Object.values(ports)));
  function button(label) {
    const attributes = [...source.matchAll(/<UButton\b([^>]*)>([^<]*)<\/UButton>/g)].find(match => match[2].trim() === label)?.[1];
    assert.ok(attributes, 'Button exists: ' + label);
    const binding = name => {
      const expression = attributes.match(new RegExp(':' + name + '="([^"]*)"'))?.[1];
      return expression ? !!new Function('context', 'with (context) { return (' + expression + '); }')(proxyRefs(values)) : false;
    };
    const loading = binding('loading');
    return { loading, disabled: loading || binding('disabled') };
  }
  return { ...values, state, button };
}
const idle = { loading: false, disabled: false };
const folder = title => ({ enabled: true, files: [{ name: title, title }], records: [], errors: [] });
const page = title => ({ rows: [{ id: title }], total: 2, asOf: 1, nextCursor: 'next' });
const plan = id => ({ enabled: true, planId: id, canApply: true, files: [] });

async function poll(f) { f.state.refreshRevision++; await nextTick(); }

test('feature polling keeps the refresh button stable and a deliberate refresh supersedes the old read', async t => {
  const oldRead = deferred(), manualRead = deferred(); let reads = 0;
  const f = await fixture(t, 'FeatureRequestsPanel', async () => ++reads === 1 ? folder('saved') : reads === 2 ? oldRead.promise : manualRead.promise);
  await f.load(); await poll(f);
  assert.equal(f.loading.value, true); assert.deepEqual(f.button('Refresh requests'), idle);
  assert.equal(f.folder.value.files[0].title, 'saved');
  const manual = f.load(); assert.equal(f.button('Refresh requests').loading, true);
  await f.load(); assert.equal(reads, 3, 'a deliberate refresh cannot be submitted twice');
  manualRead.resolve(folder('newer')); await manual;
  oldRead.resolve(folder('older')); await nextTick(); await nextTick();
  assert.equal(f.folder.value.files[0].title, 'newer'); assert.deepEqual(f.button('Refresh requests'), idle);
});

test('run polling leaves refresh, filters and pagination stable while a newer filter request wins', async t => {
  const oldRead = deferred(), manualRead = deferred(); let reads = 0; const calls = [];
  const f = await fixture(t, 'RunEvidencePanel', async (_path, _method, body) => {
    calls.push(body);
    if (body.action === 'analyze') return { total: 2 };
    return ++reads === 1 ? page('saved') : reads === 2 ? oldRead.promise : manualRead.promise;
  });
  await f.load(); await poll(f);
  assert.equal(f.loading.value, true);
  for (const label of ['Refresh runs', 'Apply filters', 'Load more attempts']) assert.deepEqual(f.button(label), idle);
  assert.equal(f.page.value.rows[0].id, 'saved');
  f.provider.value = 'claude-cli'; const manual = f.load();
  assert.equal(f.button('Apply filters').loading, true);
  assert.equal(f.button('Refresh runs').loading, false); assert.equal(f.button('Load more attempts').loading, false);
  manualRead.resolve(page('newer')); await manual;
  oldRead.resolve(page('older')); await nextTick(); await nextTick();
  assert.equal(f.page.value.rows[0].id, 'newer'); assert.equal(calls.at(-1).provider, 'claude-cli');
  assert.equal(calls.filter(call => call.action === 'analyze').length, 2, 'superseded polling does not request or adopt an old analysis');
  for (const label of ['Refresh runs', 'Apply filters', 'Load more attempts']) assert.deepEqual(f.button(label), idle);
});

test('integration polling does not disable reviewed plan application or overwrite its acknowledged result', async t => {
  const oldRead = deferred(), applyRead = deferred(); const calls = [];
  const f = await fixture(t, 'ProjectIntegrationsPanel', async (_path, _method, body) => {
    calls.push(body); return body?.action === 'plan' ? plan('reviewed') : body?.action === 'apply' ? applyRead.promise : oldRead.promise;
  });
  await f.preview(); await poll(f);
  assert.deepEqual(f.button('Preview synchronization'), idle); assert.deepEqual(f.button('Apply reviewed plan'), idle);
  const apply = f.apply(); assert.deepEqual(calls.at(-1), { action: 'apply', expectedPlan: 'reviewed' });
  assert.equal(f.button('Apply reviewed plan').loading, true); assert.equal(f.button('Preview synchronization').loading, false);
  applyRead.resolve({ ...plan('applied'), applied: true }); await apply;
  oldRead.resolve(plan('older')); await nextTick(); await nextTick();
  assert.equal(f.report.value.planId, 'applied'); assert.equal(f.reviewed.value, null); assert.equal(f.loading.value, false);
});

test('a deliberate integration preview takes over a background read and keeps its own progress indicator', async t => {
  const oldRead = deferred(), previewRead = deferred();
  const f = await fixture(t, 'ProjectIntegrationsPanel', async (_path, _method, body) => body?.action === 'plan' ? previewRead.promise : oldRead.promise);
  f.report.value = plan('saved'); await poll(f);
  const preview = f.preview(); assert.equal(f.button('Preview synchronization').loading, true);
  oldRead.resolve(plan('older')); await nextTick(); await nextTick();
  assert.equal(f.report.value.planId, 'saved'); assert.equal(f.button('Preview synchronization').loading, true);
  previewRead.resolve(plan('reviewed')); await preview;
  assert.equal(f.report.value.planId, 'reviewed'); assert.equal(f.reviewed.value.planId, 'reviewed');
  assert.deepEqual(f.button('Preview synchronization'), idle);
});

test('failed background feature reads retain the error and loaded data while retrying, and access expiry retires the result', async t => {
  const pending = deferred(); let reads = 0;
  const f = await fixture(t, 'FeatureRequestsPanel', async () => ++reads === 1 ? folder('saved') : reads === 2 ? Promise.reject(Error('Offline')) : pending.promise);
  await f.load(); await poll(f); await nextTick();
  assert.match(f.error.value, /Offline/); await poll(f);
  assert.match(f.error.value, /Offline/, 'a background retry must not briefly remove an existing error');
  assert.equal(f.folder.value.files[0].title, 'saved'); assert.deepEqual(f.button('Refresh requests'), idle);
  f.state.unlocked = false; await nextTick(); pending.resolve(folder('private')); await nextTick(); await nextTick();
  assert.equal(f.folder.value, null); assert.equal(f.loading.value, false); assert.equal(f.refreshing.value, false);
});
