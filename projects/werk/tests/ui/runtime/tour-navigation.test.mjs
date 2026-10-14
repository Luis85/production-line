import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../../../src/shared/ui/tour.js', import.meta.url), 'utf8');
function harness() {
  const nodes = [], frames = []; const document = { activeElement: null };
  class Element {
    children = []; dataset = {}; attributes = {}; listeners = {}; isConnected = true;
    classList = { values: new Set(), add(value) { this.values.add(value); }, remove(value) { this.values.delete(value); }, contains(value) { return this.values.has(value); } };
    constructor(tag) { this.tagName = tag; nodes.push(this); }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    focus() { document.activeElement = this; }
    remove() { this.isConnected = false; }
    show() {} scrollIntoView() {}
  }
  document.createElement = tag => new Element(tag); document.body = new Element('body');
  document.querySelector = selector => nodes.find(node => node.isConnected && (selector.startsWith('#') ? node.id === selector.slice(1) : node.dataset.werkTour !== undefined));
  const context = vm.createContext({ document, requestAnimationFrame: fn => frames.push(fn) }); vm.runInContext(source, context);
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); for (const frame of frames.splice(0)) frame(); };
  const button = name => nodes.filter(node => node.tagName === 'button' && node.textContent === name).at(-1);
  return { document, nodes, flush, button, start: context.WerkTour, element: tag => new Element(tag) };
}
test('tour awaits asynchronous navigation before highlighting and focusing the new step', async () => {
  const h = harness(); let release;
  const tour = h.start('Worker', [{ title: 'Lazy view', text: 'Inspect the task', target: '#late', activate: () => new Promise(resolve => { release = resolve; }) }]);
  await h.flush(); assert.equal(h.button('Next').disabled, true);
  const target = h.element('section'); target.id = 'late'; release(); await h.flush();
  assert.equal(target.classList.contains('werk-tour-target'), true);
  assert.equal(h.document.activeElement.id, 'werk-tour-heading'); assert.equal(h.button('Finish').disabled, false);
  tour.close(); assert.equal(target.classList.contains('werk-tour-target'), false);
});
test('closing a tour during navigation fences late focus and restores its trigger', async () => {
  const h = harness(), trigger = h.element('button'); let release;
  const tour = h.start('Worker', [{ title: 'Lazy view', text: 'Inspect', target: '#late', activate: () => new Promise(resolve => { release = resolve; }) }], trigger);
  tour.close(); const target = h.element('section'); target.id = 'late'; release(); await h.flush();
  assert.equal(h.document.activeElement, trigger); assert.equal(target.classList.contains('werk-tour-target'), false);
});
test('restarting a tour clears the prior target and activation failure stays recoverable', async () => {
  const h = harness(), first = h.element('section'); first.id = 'first';
  h.start('Worker', [{ title: 'First', text: 'Inspect', target: '#first' }]); await h.flush(); assert.equal(first.classList.contains('werk-tour-target'), true);
  const next = h.start('Worker', [{ title: 'Failed view', text: 'Inspect', activate: async () => { throw Error('Navigation failed'); } }]); await h.flush();
  assert.equal(first.classList.contains('werk-tour-target'), false); assert.equal(h.button('Finish').disabled, false);
  assert.ok(h.nodes.some(node => node.textContent?.includes('could not be opened'))); next.close();
});
