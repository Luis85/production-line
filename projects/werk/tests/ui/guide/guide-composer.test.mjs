import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { validateDefinition, renderDefinition } from '../../../src/guide/webview/composer.ts';
import { validateDefinition as validateSystem } from '../../../scripts/system/definition.mjs';
const initial = { id: 'my-system', factory: 'My Factory', factoryPort: '3100', line: 'alpha', project: 'demo-alpha', port: '3001', workers: '2', workerPort: '4201' };
test('guide downloads launcher-valid YAML in each deployment mode with mock worker scope', () => {
  const environments = /** @type {const} */ (['native', 'docker']);
  for (const environment of environments) {
    const yaml = renderDefinition({ ...initial, factory: 'Team "Alpha": Research #1' }, environment);
    const definition = validateSystem(parse(yaml)); assert.equal(definition.environment, environment); assert.equal(definition.productionLines[0].workers.count, 2); assert.equal(definition.productionLines[0].workers.statusPort, 4201); assert.equal(definition.factory.name, 'Team "Alpha": Research #1'); assert.equal(definition.productionLines[0].workers.execution, undefined); assert.doesNotMatch(yaml, /token|apiKey|credentials/);
  }
});
test('guide validation rejects overlapping and overflowing ranges, reserved IDs and invalid whole numbers', () => {
  for (const change of [{ port: '4202' }, { workers: '8', workerPort: '65530' }, { factoryPort: '3100.5' }, { workers: '2.5' }, { id: 'con' }, { line: 'alpha\nbeta' }, { project: '../private' }, { factory: 'Name\u0000bad' }]) {
    const draft = { ...initial, ...change }; assert.ok(validateDefinition(draft)); assert.throws(() => renderDefinition(draft, 'native'));
  }
});
test('guide maximum system ID keeps derived Factory ID inside the launcher boundary', () => {
  const draft = { ...initial, id: 'a'.repeat(55), line: 'b'.repeat(63), workers: '8', workerPort: '65528' };
  assert.equal(validateDefinition(draft), ''); const definition = validateSystem(parse(renderDefinition(draft, 'native'))); assert.equal(definition.factory.id.length, 63); assert.equal(definition.productionLines[0].workers.count, 8);
});
