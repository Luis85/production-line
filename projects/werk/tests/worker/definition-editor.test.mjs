import { normalizeSource } from '../helpers/source-text.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { ref, watch, nextTick, effectScope } from 'vue';
async function editor(t, request) {
  const source = normalizeSource(await readFile(new URL('../../src/worker/webview/components/DefinitionPanel.vue', import.meta.url), 'utf8'));
  const script = source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\n/gm, '');
  const ports = { ref, watch, nextTick, request, refresh: async () => {}, state: { definitions: [] } };
  const scope = effectScope(); t.after(() => scope.stop());
  return scope.run(() => new Function(...Object.keys(ports), ts.transpile(script, { target: ts.ScriptTarget.ES2022 }) + '\nreturn { act, yaml, name, preview, reviewedYaml, busy, notice, error };')(...Object.values(ports)));
}
for (const field of ['yaml', 'name']) {
  test(`definition import preserves newer ${field} edits while saving the reviewed snapshot`, async t => {
    let resolve, submitted, calls = 0;
    const saving = new Promise(done => { resolve = done; });
    const f = await editor(t, async (path, method, body) => { calls++; submitted = body; return saving; });
    f.yaml.value = 'agents: reviewed'; f.name.value = 'Reviewed name'; await nextTick();
    f.preview.value = [{ name: 'root' }]; f.reviewedYaml.value = f.yaml.value;
    const pending = f.act('import'); f[field].value = 'Newer unsaved edit'; await nextTick(); await f.act('import');
    assert.equal(calls, 1); assert.equal(submitted.yaml, 'agents: reviewed'); assert.equal(submitted.name, 'Reviewed name');
    resolve({}); await pending;
    assert.equal(f[field].value, 'Newer unsaved edit'); assert.match(f.notice.value, /newer definition edits are kept/); assert.equal(f.busy.value, false);
  });
}
test('successful import clears unchanged reviewed fields; failed import retains them', async t => {
  let fails = false;
  const f = await editor(t, async () => { if (fails) throw Error('Unable to save definition'); return {}; });
  const prepare = async () => { f.yaml.value = 'agents: reviewed'; f.name.value = 'Reviewer'; await nextTick(); f.preview.value = []; f.reviewedYaml.value = f.yaml.value; };
  await prepare(); await f.act('import'); assert.equal(f.yaml.value, ''); assert.equal(f.name.value, '');
  fails = true; await prepare(); await f.act('import');
  assert.equal(f.yaml.value, 'agents: reviewed'); assert.equal(f.name.value, 'Reviewer'); assert.match(f.error.value, /Unable to save/);
});
