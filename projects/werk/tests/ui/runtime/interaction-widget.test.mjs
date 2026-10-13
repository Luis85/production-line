import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
const source = await readFile(new URL('../../../src/shared/ui/interaction.js', import.meta.url), 'utf8');
const event = { preventDefault() {} };
const snapshot = (id, messages = [], phase = 'idle') => ({ sessions: { selected: id, records: [{ id, title: messages.length ? messages[0].text : 'New task' }] }, chat: { messages, phase, busy: phase !== 'idle', available: true } });
const message = text => ({ role: 'user', text });
function harness(request, canWrite = true) {
  const nodes = [], timers = new Map(); let nextTimer = 0;
  const document = { activeElement: null, hidden: false };
  class Element {
    children = []; value = ''; hidden = false; disabled = false; listeners = {};
    constructor(tag, text, klass) { this.tagName = tag; this.textContent = text ?? ''; this.className = klass; nodes.push(this); }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    setAttribute() {} focus() { document.activeElement = this; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    showModal() {} close() { this.listeners.close?.(); } remove() { this.removed = true; }
  }
  const el = (tag, text, klass) => new Element(tag, text, klass);
  const button = (text, onclick) => { const node = el('button', text); node.onclick = onclick; return node; };
  document.body = el('body');
  const context = vm.createContext({ document, crypto: { randomUUID }, WerkSpatial: { el, button }, setInterval: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearInterval: id => timers.delete(id) });
  vm.runInContext(source, context);
  const widget = context.WerkInteraction({ title: 'Line interaction', project: 'demo', canWrite, request, submit: async () => ({ id: 'line-task' }) });
  const id = id => nodes.find(node => node.id === id), text = text => nodes.find(node => node.tagName === 'button' && node.textContent === text) ?? nodes.find(node => node.textContent === text);
  const connect = async () => { id('interaction-worker-url').value = 'http://worker.example'; id('interaction-worker-token').value = 'memory-only-token'; await text('Connect model session').parent.onsubmit(event); };
  const send = async value => { id('interaction-message').value = value; await id('interaction-message').parent.parent.onsubmit(event); await new Promise(resolve => setImmediate(resolve)); };
  return { id, text, nodes, document, connect, send, widget, timers };
}

test('first Chat message queues a task, followups retain its session, and New task resets the task view', async () => {
  const calls = []; let selected = 'original', messages = [];
  const h = harness(async input => { calls.push(input); if (input.action === 'new') { selected = 'created'; messages = []; } if (input.action === 'send') messages.push(message(input.message)); return snapshot(selected, messages); });
  await h.connect(); assert.ok(h.text('Queue task')); assert.equal(h.id('interaction-worker-token').value, '');
  await h.send('Implement acceptance criteria'); assert.ok(h.text('Send follow-up'));
  await h.send('Also document the result');
  assert.deepEqual(calls.filter(item => item.action === 'send').map(item => item.sessionId), ['original', 'original']);
  h.id('interaction-message').value = 'Draft for old task'; await h.text('New task').onclick();
  assert.equal(h.id('interaction-message').value, ''); assert.ok(h.text('Queue task'));
  assert.equal(h.nodes.find(node => node.tagName === 'h3').textContent, 'New task');
  await h.send('A separate task'); assert.equal(calls.at(-1).sessionId, 'created');
  h.widget.close(); assert.equal(h.timers.size, 0);
});

test('session changes restore reconnect controls without losing the unsent draft', async () => {
  let selected = 'original'; const h = harness(async () => snapshot(selected)); await h.connect();
  h.id('interaction-message').value = 'Preserve this draft'; selected = 'elsewhere'; await h.text('Refresh conversation').onclick();
  assert.equal(h.text('Connect model session').parent.hidden, false); assert.equal(h.id('interaction-message').value, 'Preserve this draft');
  assert.equal(h.document.activeElement, h.id('interaction-worker-token')); assert.equal(h.text('Queue task').disabled, true); assert.equal(h.timers.size, 0);
});

test('reconnecting fences a late response and New task failures preserve the draft', async () => {
  let release, reads = 0; const pending = new Promise(resolve => { release = resolve; });
  const h = harness(async input => { if (input.action === 'new') throw Error('Task was not created'); return ++reads === 2 ? pending : snapshot(reads === 1 ? 'original' : 'replacement'); });
  await h.connect(); const old = h.text('Refresh conversation').onclick(); h.text('Change worker / reconnect').onclick(); await h.connect();
  release(snapshot('original', [message('Stale private task')])); await old;
  assert.ok(h.text('Task session: replacement')); assert.equal(h.text('Stale private task'), undefined);
  h.id('interaction-message').value = 'Keep this draft'; await h.text('New task').onclick();
  assert.equal(h.id('interaction-message').value, 'Keep this draft'); assert.ok(h.text('Task was not created'));
});

test('read-only widgets cannot create worker tasks even through a programmatic action', async () => {
  const calls = []; const h = harness(async input => { calls.push(input); return snapshot('original'); }, false);
  await h.connect(); assert.equal(h.text('New task').disabled, true); assert.equal(h.text('Queue task').disabled, true);
  await h.text('New task').onclick(); await h.send('Unapproved task'); assert.equal(calls.length, 1);
});
