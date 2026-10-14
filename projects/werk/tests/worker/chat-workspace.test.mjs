import { normalizeSource } from '../helpers/source-text.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { computed, nextTick, reactive, ref, watch } from 'vue';

async function componentScript(file, ports, exports) {
  const source = normalizeSource(await readFile(new URL('../../src/worker/webview/' + file, import.meta.url), 'utf8'));
  const script = /<script setup[^>]*>([\s\S]*?)<\/script>/.exec(source)[1].replace(/^import .*;\n/gm, '');
  const javascript = ts.transpile(script, { target: ts.ScriptTarget.ES2022 });
  const dependencies = { computed, nextTick, reactive, ref, watch, ...ports };
  return new Function(...Object.keys(dependencies), javascript + '\nreturn { ' + exports.join(', ') + ' };')(...Object.values(dependencies));
}

test('closing or escaping inline Chat setup returns focus to its initiating control', async () => {
  const focused = [];
  const trigger = { isConnected: true, focus: () => focused.push('trigger') };
  const field = { focus: () => focused.push('field') };
  const document = { activeElement: trigger, getElementById: () => field };
  const state = reactive({ sessions: null, chat: null, workspaceBusy: false });
  const chat = await componentScript('pages/ChatPage.vue', { state, document, chatAction: async () => {} }, ['showSetup', 'closeSetup', 'showDefinitions', 'closeDefinitions', 'escapePanels', 'setup']);
  await chat.showSetup(); assert.equal(chat.setup.value, true);
  await chat.closeSetup(); assert.equal(chat.setup.value, false); assert.equal(focused.at(-1), 'trigger');
  await chat.showSetup();
  let prevented = false;
  chat.escapePanels({ key: 'Escape', target: { closest: selector => selector === '.chat-provider-setup' }, preventDefault: () => { prevented = true; } });
  await nextTick(); assert.equal(chat.setup.value, false); assert.equal(prevented, true); assert.equal(focused.at(-1), 'trigger');
  await chat.showDefinitions(); await chat.closeDefinitions(); assert.equal(focused.at(-1), 'trigger');
});

test('new draft task rejects a removed definition or agent without falling back silently', async () => {
  let created = 0;
  const state = reactive({ workspaceBusy: false, settings: { providers: [{ id: 'codex-cli', configured: true }] }, definitions: [] });
  const task = await componentScript('components/NewTask.vue', { state, newTask: async () => { created++; return {}; }, defineEmits: () => () => {} }, ['definitionId', 'agent', 'create', 'canCreate']);
  task.definitionId.value = 'removed'; await nextTick();
  assert.equal(task.canCreate.value, false); await task.create(); assert.equal(created, 0);
  state.definitions = [{ id: 'removed', agents: [{ name: 'root', provider: 'openai', requiresAdaptation: false }] }];
  task.agent.value = 'missing'; await nextTick(); await task.create(); assert.equal(created, 0);
  task.agent.value = 'root'; await nextTick(); await task.create(); assert.equal(created, 1);
});
