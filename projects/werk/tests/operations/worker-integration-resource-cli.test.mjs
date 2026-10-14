import test from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../../scripts/runtime/portable/commands.mjs';
import { workerBody } from '../../scripts/runtime/portable/worker-commands.mjs';
const catalog = commands('worker');
test('integration CLI discovers local read-only plans and guarded sync', () => {
  for (const name of ['status', 'plan']) { assert.equal(catalog['integrations ' + name].local, true); assert.equal(catalog['integrations ' + name].mutating, false); }
  assert.equal(catalog['integrations sync'].mutating, true);
  assert.deepEqual(catalog['integrations sync'].options, ['project-dir', 'if-match', 'dry-run']);
});
test('resource inspection retains GET semantics and typed resumable event pagination', async () => {
  assert.equal(catalog['resource status'].method, 'GET');
  assert.equal(await workerBody(catalog['resource status'], undefined, {}), undefined);
  assert.equal(catalog['resource events'].mutating, false);
  assert.deepEqual(await workerBody(catalog['resource events'], undefined, {after:'42',limit:'10'}), {action:'events',after:42,limit:10});
  for (const options of [{after:'-1'},{after:'9007199254740992'},{limit:'0'},{limit:'101'},{limit:'1.5'}]) await assert.rejects(workerBody(catalog['resource events'], undefined, options), /integer/);
});
