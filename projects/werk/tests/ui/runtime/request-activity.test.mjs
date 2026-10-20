import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as vue from 'vue';
import { deferred } from '../helpers/frontend-loader.mjs';
const source = await readFile(new URL('../../../src/worker/webview/components/RequestActivityPanel.vue', import.meta.url), 'utf8');
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const javascript = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function fixture() {
  const props = vue.reactive({ requestId: 'request-a', revision: 1 });
  const pending = [], calls = [], scope = vue.effectScope();
  const ports = {
    vue: { ...vue, onBeforeUnmount() {} },
    '@nuxt/ui/components/Button.vue': {},
    '../store': { state: vue.reactive({ unlocked: true }), date: value => value, request: async (_path, _method, body) => {
      const response = deferred(); calls.push(body); pending.push(response); return response.promise;
    } },
  };
  const load = new Function('require', 'defineProps', 'exports', javascript + '; return { events, filter, visible, load };');
  const view = scope.run(() => load(id => { assert.ok(id in ports, 'Unexpected module: ' + id); return ports[id]; }, () => props, {}));
  return { props, calls, pending, view, close: () => scope.stop() };
}
const page = (events = [], hasMore = false) => ({ schemaVersion: 1, requestId: 'request-a', events, nextAfter: events.at(-1)?.sequence ?? 0, hasMore });
const event = sequence => ({ schemaVersion: 1, id: 'event-' + sequence, sequence, requestId: 'request-a', revision: sequence, type: 'delivery_updated', phase: 'running', at: '2026-10-20T12:00:00Z', inputRevision: 1 });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a request revision arriving during an activity read schedules one catch-up without clearing filters', async t => {
  const f = fixture(); t.after(f.close);
  assert.equal(f.calls.length, 1);
  f.view.filter.value = 'delivery'; f.props.revision = 2; await vue.nextTick();
  f.props.revision = 3; await vue.nextTick();
  assert.equal(f.calls.length, 1, 'revision updates do not overlap reads');
  f.pending[0].resolve(page([event(1)])); await settle();
  assert.equal(f.calls.length, 2, 'one follow-up reads events that arrived during the first request');
  assert.equal(f.calls[1].after, 1);
  f.pending[1].resolve(page([event(2), event(3)])); await settle();
  assert.deepEqual(f.view.visible.value.map(row => row.sequence), [1, 2, 3]);
  assert.equal(f.view.filter.value, 'delivery'); assert.equal(f.calls.length, 2);
});

test('a catch-up does not bypass a paginated timeline requiring explicit load more', async t => {
  const f = fixture(); t.after(f.close);
  f.props.revision = 2; await vue.nextTick();
  f.pending[0].resolve(page([event(1)], true)); await settle();
  assert.equal(f.calls.length, 1);
  const next = f.view.load(true); assert.equal(f.calls[1].after, 1);
  f.pending[1].resolve(page([event(2)])); await next;
  assert.deepEqual(f.view.events.value.map(row => row.sequence), [1, 2]);
});


test('activity search matches both delivery step and provider invocation identities', async t => {
  const f = fixture(); t.after(f.close);
  f.pending[0].resolve(page([{ ...event(1), deliveryRunId: 'delivery-one', deliveryStepId: 'verification-step', runId: 'provider-invocation' }, { ...event(2), deliveryRunId: 'delivery-two' }])); await settle();
  for (const filter of ['verification-step', 'provider-invocation', 'delivery-one']) {
    f.view.filter.value = filter;
    assert.deepEqual(f.view.visible.value.map(row => row.sequence), [1]);
  }
  f.view.filter.value = 'delivery-two'; assert.deepEqual(f.view.visible.value.map(row => row.sequence), [2]);
});
