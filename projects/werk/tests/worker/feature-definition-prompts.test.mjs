import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultFeatureWorkflow, validateFeatureWorkflow, featureContentHash, validateFeatureDefinitionPrompts, validateFeaturePromptContent } from '../../src/worker/dist/worker/application/feature-workflow.js';

const commit = 'a'.repeat(40);
const prompt = (path = 'team/ready.md', content = 'Clarify acceptance criteria before implementation.\n') => ({ path, content, sha256: featureContentHash(content) });
const snapshot = overrides => ({ schemaVersion: 1, commit, ready: prompt(), ...overrides });

test('definition paths are optional, independent and retain existing workflow defaults', () => {
  const defaults = defaultFeatureWorkflow();
  assert.equal(Object.hasOwn(defaults, 'readyPrompt'), false);
  assert.equal(Object.hasOwn(defaults, 'donePrompt'), false);
  assert.deepEqual(validateFeatureWorkflow(defaults), defaults);
  const configured = { ...defaults, readyPrompt: 'team/ready.md', donePrompt: 'team/done.txt' };
  assert.deepEqual(validateFeatureWorkflow(configured), configured);
  assert.equal(validateFeatureWorkflow({ ...defaults, donePrompt: 'features/_done.md' }).donePrompt, 'features/_done.md');
  assert.equal(validateFeatureWorkflow({ ...defaults, readyPrompt: 'features/ready.txt' }).readyPrompt, 'features/ready.txt');
});

test('definition paths cannot escape, collide or become intake or generated notes', () => {
  const defaults = defaultFeatureWorkflow();
  for (const path of [null, '', '../ready.md', '/tmp/ready.md', 'C:/ready.md', 'team\\ready.md', 'team/ready.json', 'team/ready', '.git/ready.md', '.werk/worker/ready.md', '.agents/ready.md', 'bin/apps/ready.md', 'feature-reviews/ready.md', 'feature-tasks/done.md', 'features/ready.md', defaults.template]) {
    assert.throws(() => validateFeatureWorkflow({ ...defaults, readyPrompt: path }), undefined, String(path));
  }
  assert.throws(() => validateFeatureWorkflow({ ...defaults, readyPrompt: 'team/ready.md', donePrompt: 'TEAM/ready.md' }), /distinct/);
  assert.throws(() => validateFeatureWorkflow({ ...defaults, definitionPrompt: 'team/ready.md' }), /fields/);
});

test('definition context verifies immutable provenance and returns independent values', () => {
  const input = snapshot({ done: prompt('team/done.txt', 'Report verified evidence and remaining limitations.\n') });
  const accepted = validateFeatureDefinitionPrompts(input);
  assert.deepEqual(accepted, input);
  input.ready.content = 'Changed after acceptance';
  input.done.path = 'team/other.txt';
  assert.equal(accepted.ready.content, 'Clarify acceptance criteria before implementation.\n');
  assert.equal(accepted.done.path, 'team/done.txt');
  assert.deepEqual(validateFeatureDefinitionPrompts({ schemaVersion: 1, commit: 'b'.repeat(64), done: prompt('team/done.md') }).done, prompt('team/done.md'));
});

test('malformed, empty or tampered definition context is never accepted as dispatch context', () => {
  for (const input of [null, [], {}, snapshot({ schemaVersion: 2 }), snapshot({ commit: 'main' }), snapshot({ commit: 'a'.repeat(41) }), snapshot({ commit: 'A'.repeat(40) }), snapshot({ ready: undefined }), snapshot({ extra: true }), snapshot({ ready: { ...prompt(), extra: true } }), snapshot({ ready: { ...prompt(), content: 'Changed after hashing' } }), snapshot({ ready: { ...prompt(), sha256: 'b'.repeat(64) } }), snapshot({ ready: prompt('../ready.md') }), snapshot({ ready: prompt('ready.json') }), snapshot({ done: prompt('TEAM/ready.md') })]) {
    assert.throws(() => validateFeatureDefinitionPrompts(input));
  }
});

test('prompt bounds count UTF-8 bytes and reject invalid Unicode, NUL and blank content', () => {
  const maximum = 'é'.repeat(32768);
  assert.equal(validateFeaturePromptContent(maximum, 'ready.md'), maximum);
  assert.equal(validateFeatureDefinitionPrompts(snapshot({ ready: prompt('ready.md', maximum) })).ready.content, maximum);
  for (const content of ['', ' \r\n\t', 'safe\0hidden', '\ud800', '\udc00', maximum + 'a', undefined, 42]) {
    assert.throws(() => validateFeaturePromptContent(content, 'ready.md'), /nonempty UTF-8 text/);
    assert.throws(() => validateFeatureDefinitionPrompts(snapshot({ ready: { ...prompt(), content } })));
  }
});
