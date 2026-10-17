import { resultWith } from './contract-fixtures.mjs';
import { testErrorCode, testErrorMessage } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerDefinitions } from '../../src/worker/dist/worker/application/definitions.js';

const yaml = 'agents:\n  root:\n    instruction: Review the feature.\n';

test('a failed definition write leaves committed state intact and does not block an already queued import', async () => {
  const entered = Promise.withResolvers(), held = Promise.withResolvers(), failure = Error('disk full');
  let saved, writes = 0;
  const definitions = new WorkerDefinitions({
    async read() { return saved; },
    async write(body) { writes++; if (writes === 1) { entered.resolve(); await held.promise; throw failure; } saved = body; },
  });
  await definitions.init();
  const failed = definitions.action({ action: 'import', name: 'Unsaved', yaml });
  const rejected = assert.rejects(failed, error => error === failure);
  const queued = definitions.action({ action: 'import', name: 'Saved', yaml });
  await entered.promise;
  assert.deepEqual(definitions.view().definitions, []);
  held.resolve();
  await rejected;
  const result = resultWith(await queued, 'definitions');
  assert.equal(writes, 2);
  assert.deepEqual(result.definitions.map(item => item.name), ['Saved']);
  assert.deepEqual(JSON.parse(saved).map(item => item.name), ['Saved']);
});

test('concurrent definition updates recheck the reviewed revision after the prior durable write', async () => {
  const entered = Promise.withResolvers(), held = Promise.withResolvers();
  let saved, writes = 0;
  const definitions = new WorkerDefinitions({
    async read() { return saved; },
    async write(body) { writes++; if (writes === 2) { entered.resolve(); await held.promise; } saved = body; },
  });
  await definitions.init();
  const initial = (resultWith(await definitions.action({ action: 'import', name: 'Reviewer', ref: 'reviewer', yaml }), 'definitions')).definitions[0];
  const command = { action: 'update', ref: 'reviewer', revision: initial.revision, yaml };
  const first = definitions.action({ ...command, name: 'First update' });
  const second = definitions.action({ ...command, name: 'Stale update' });
  const rejected = assert.rejects(second, error => testErrorCode(error) === 'conflict' && /changed/.test(testErrorMessage(error)));
  await entered.promise;
  assert.equal(definitions.view().definitions[0].name, 'Reviewer');
  held.resolve();
  await first;
  await rejected;
  assert.equal(writes, 2);
  assert.equal(definitions.view().definitions[0].name, 'First update');
  assert.equal(JSON.parse(saved)[0].name, 'First update');
  assert.notEqual(definitions.view().definitions[0].revision, initial.revision);
});
