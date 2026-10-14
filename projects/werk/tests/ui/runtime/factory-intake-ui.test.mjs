import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { randomUUID } from 'node:crypto';

const source = await readFile(new URL('../../../src/factory/public/experience.js', import.meta.url), 'utf8');
const syntax = ts.createSourceFile('experience.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(), assignments = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(syntax));
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const key = node.left.getText(syntax);
    if (ts.isFunctionExpression(node.right) || ts.isArrowFunction(node.right)) assignments.set(key, node.right.getText(syntax));
  }
  ts.forEachChild(node, visit);
}
visit(syntax);
const control = value => ({ value, required: true, disabled: false, textContent: '', dataset: {}, setAttribute() {} });
function fixture(api = async () => ({ id: 'saved', reason: 'Accepted' })) {
  const names = ['title', 'criteria', 'reference', 'project', 'provider', 'execution', 'factory', 'destination'];
  const fields = Object.fromEntries(names.map(name => [name, control('')]));
  Object.assign(fields.title, { value: 'Saved fixture' }); fields.criteria.value = 'Criteria'; fields.project.value = 'demo';
  fields.provider.value = 'auto'; fields.execution.value = 'mock'; fields.factory.value = 'fixture';
  const form = { setAttribute() {}, querySelectorAll: () => Object.values(fields), reset() { for (const field of Object.values(fields)) field.value = ''; } };
  const routingForm = { setAttribute() {}, querySelectorAll: () => [], reset() { this.resets = (this.resets || 0) + 1; } };
  const context = vm.createContext({ ...fields, form, routingForm, send: control(''), save: control(''), policyLine: control(''), policyMode: control('auto'), paused: {checked:false}, fillLines() {}, state: { token: 'private-memory-fixture', canWrite: true, saving: false, session: 1 }, crypto: { randomUUID }, api, loadQueue: async () => {}, feedback: control(''), queue: { replaceChildren() {} }, lineMap: { update() {} }, previousDisconnect() { context.state.token = ''; context.state.session++; } });
  vm.runInContext(`let submitting=false,policySaving=false,widget=null,request=0,queueRequest=0,lastOverview=null,registrySignature='',scopeSignature='',taskKey='retained-key',lastTask=''; const policyDrafts=new Map();\n${functions.get('updateTaskValidation')}\n${functions.get('setIntakeBusy')}\n${functions.get('setRoutingBusy')}\n${functions.get('rememberPolicyDraft')}\n${functions.get('loadPolicy')}\nform.onsubmit=${assignments.get('form.onsubmit')};\ndisconnect=${assignments.get('disconnect')};`, context);
  return { context, fields, form, run: code => vm.runInContext(code, context) };
}

test('Factory expiry retains unsent intake and retry key; explicit disconnect clears them', () => {
  const surface = fixture(); surface.fields.reference.value = '[[Fixtures/Requirement]]';
  surface.run('disconnect({preserveDrafts:true})');
  assert.equal(surface.fields.title.value, 'Saved fixture'); assert.equal(surface.fields.reference.value, '[[Fixtures/Requirement]]');
  assert.equal(surface.run('taskKey'), 'retained-key');
  assert.equal(surface.fields.title.required, false);
  surface.run('disconnect()'); assert.equal(surface.fields.title.value, ''); assert.equal(surface.fields.reference.value, '');
  assert.equal(surface.fields.title.required, true); assert.equal(surface.fields.criteria.required, true);
  assert.notEqual(surface.run('taskKey'), 'retained-key');
});

test('Factory intake prevents duplicate submission and restores manual validation after reference success', async () => {
  let release, calls = 0;
  const surface = fixture(() => { calls++; return new Promise(resolve => { release = resolve; }); });
  surface.fields.reference.value = '[[Fixtures/Requirement]]'; surface.run('updateTaskValidation()');
  const pending = surface.form.onsubmit({ preventDefault() {} });
  await surface.form.onsubmit({ preventDefault() {} }); assert.equal(calls, 1); assert.equal(surface.fields.project.disabled, true);
  release({ id: 'saved', reason: 'Accepted' }); await pending;
  assert.equal(surface.fields.reference.value, ''); assert.equal(surface.fields.title.required, true); assert.equal(surface.fields.criteria.required, true);
  assert.equal(surface.fields.project.disabled, false); assert.equal(surface.context.feedback.dataset.kind, 'success');
});

test('Factory failed intake preserves inputs and the same idempotency key for retry', async () => {
  const keys = []; const surface = fixture(async (_path, options) => { keys.push(options.idempotencyKey); throw Error('Offline'); });
  await surface.form.onsubmit({ preventDefault() {} }); await surface.form.onsubmit({ preventDefault() {} });
  assert.equal(surface.fields.title.value, 'Saved fixture'); assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
  assert.equal(surface.fields.title.disabled, false); assert.equal(surface.context.feedback.dataset.kind, 'error');
  assert.match(surface.context.feedback.textContent, /Eingaben bleiben erhalten/);
});


test('Factory routing draft survives background reload and supersedes an older policy response', async () => {
  let release; const surface=fixture(() => new Promise(resolve => { release=resolve; }));
  const pending=surface.run('loadPolicy()');
  surface.context.policyMode.value='manual';surface.context.policyLine.value='line-fixture';surface.context.paused.checked=true;
  surface.run('rememberPolicyDraft()');
  release({mode:'auto',lineId:null,paused:false});await pending;
  assert.equal(surface.context.policyMode.value,'manual');assert.equal(surface.context.policyLine.value,'line-fixture');assert.equal(surface.context.paused.checked,true);
  surface.context.policyMode.value='auto';surface.context.policyLine.value='';surface.context.paused.checked=false;
  await surface.run('loadPolicy()');
  assert.equal(surface.context.policyMode.value,'manual');assert.equal(surface.context.policyLine.value,'line-fixture');assert.equal(surface.context.paused.checked,true);
  surface.run('setRoutingBusy(true)');assert.equal(surface.fields.factory.disabled,true);
  surface.run('setRoutingBusy(false)');assert.equal(surface.fields.factory.disabled,false);
});
