import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateInspectionBounds } from '../../src/worker/dist/worker/application/execution-policy.js';
const execute = promisify(execFile);
const cli = new URL('../../scripts/runtime/portable/cli.mjs', import.meta.url).href;
// Exercise shipped dispatch code, without a running app, credentials or inference.
async function help(kind) {
  const { stdout, stderr } = await execute(process.execPath, ['--input-type=module', '-e',
    `const {main}=await import(${JSON.stringify(cli)});await main(${JSON.stringify(kind)},['help']);`], { timeout: 10000 });
  assert.equal(stderr, '');
  return JSON.parse(stdout);
}
test('worker help exposes bounded local policy and safe gate recovery without changing command schema', async () => {
  const value = await help('worker');
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.executionPolicy.environment, 'WERK_WORKER_MAX_RUNTIME_MS');
  assert.equal(value.executionPolicy.defaultMs, 6 * 60 * 60 * 1000);
  assert.equal(value.executionPolicy.maximumMs, 24 * 60 * 60 * 1000);
  assert.match(value.executionPolicy.scope, /not total session age/);
  for (const [field, { default: fallback, minimum, maximum }] of Object.entries(candidateInspectionBounds))
    assert.deepEqual({ ...value.executionPolicy.candidateInspection[field], constraint: undefined }, { default: fallback, minimum, maximum, constraint: undefined }, `schema text matches the enforced ${field} range`);
  assert.deepEqual(value.executionPolicy.candidateInspection.guard.fields, Object.keys(candidateInspectionBounds));
  assert.equal(value.executionPolicy.candidateInspection.guard.field, 'expectedCandidateInspection');
  assert.match(value.executionPolicy.candidateInspection.guard.behavior, /all three current values.*reject stale/);
  assert.match(value.requestGates.dispatch, /never admits new work/);
  assert.deepEqual(value.commands['request execute'].required, ['id', 'if-match', 'key']);
  assert.equal(value.commands['request execute'].body, false);
  assert.equal(value.commands['resource status'].mutating, false);
});
test('other app help keeps worker-only configuration out of its contract', async () => {
  for (const kind of ['factory', 'orchestrator']) {
    const value = await help(kind);
    assert.equal(value.application, kind);
    assert.equal(value.executionPolicy, undefined);
    assert.equal(value.requestGates, undefined);
    assert.equal(value.commands.health.method, 'GET');
  }
});
test('api --path explains a Git Bash converted path and keeps the generic message otherwise', async () => {
  const state = join(tmpdir(), 'werk-cli-msys-state');
  const run = path => execute(process.execPath, ['--input-type=module', '-e',
    `const {main}=await import(${JSON.stringify(cli)});await main('worker',['api','--state-dir',${JSON.stringify(state)},'--path',${JSON.stringify(path)}]);`], { timeout: 10000 }).then(() => assert.fail('expected rejection'), error => JSON.parse(error.stderr));
  for (const converted of ['C:/Program Files/Git/api/requests', String.raw`C:\Program Files\Git\api\requests`]) {
    const value = await run(converted);
    assert.match(value.error, /Git Bash converted/); assert.match(value.error, /MSYS_NO_PATHCONV=1/); assert.equal(value.exitCode, 2);
  }
  assert.match((await run('api/requests')).error, /Use a local API path and supported method/);
});
