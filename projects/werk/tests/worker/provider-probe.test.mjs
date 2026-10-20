import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { runProviderProbe } from '../../src/worker/dist/worker/infrastructure/provider-process.js';
import { ProcessRunError, prepareProcessRuntime } from '../../src/worker/dist/shared/process/launcher.js';

// Establish native process readiness before testing the unchanged per-operation deadlines.
before(async t => prepareProcessRuntime(process.cwd(), t.signal), { timeout: 45000 });

test('provider probes preserve account lookup, bound both streams and remove private cwd before settling', { timeout: 20000 }, async t => {
  const original = process.env.WERK_PROBE_PRIVATE_SECRET;
  process.env.WERK_PROBE_PRIVATE_SECRET = 'must-not-inherit';
  t.after(() => { if (original === undefined) delete process.env.WERK_PROBE_PRIVATE_SECRET; else process.env.WERK_PROBE_PRIVATE_SECRET = original; });
  const script = `console.log(JSON.stringify({cwd:process.cwd(),home:process.env.HOME??null,secret:process.env.WERK_PROBE_PRIVATE_SECRET??null}));console.error('private-stderr');`;
  const result = await runProviderProbe(process.execPath, 'claude', ['-e', script], { signal: t.signal, timeoutMs: 10000, maxOutputBytes: 4096 });
  const value = JSON.parse(result.stdout.toString()); assert.equal(value.secret, null); assert.equal(value.home, process.env.HOME ?? null); assert.equal(result.stderr.length, 0);
  assert.notEqual(value.cwd, process.cwd()); await assert.rejects(access(value.cwd), { code: 'ENOENT' });
  await assert.rejects(runProviderProbe(process.execPath, 'claude', ['-e', `console.error('private'.repeat(10000));setInterval(()=>{},1000)`], { signal: t.signal, timeoutMs: 10000, maxOutputBytes: 1024 }), error => error instanceof ProcessRunError && error.reason === 'output_limit' && error.result.stderr.length === 0);
});

test('provider probe deadline removes the private directory and returns a sanitized failure', { timeout: 20000 }, async t => {
  let failure;
  try {
    await runProviderProbe(process.execPath, 'codex', ['-e', `console.log(process.cwd());setInterval(()=>{},1000)`], { signal: t.signal, timeoutMs: process.platform === 'win32' ? 5000 : 1000, maxOutputBytes: 1024 });
  } catch (error) { failure = error; }
  assert.ok(failure instanceof ProcessRunError); assert.equal(failure.reason, 'timeout');
  const directory = failure.result.stdout.toString().trim(); assert.ok(directory);
  await assert.rejects(access(directory), { code: 'ENOENT' });
});
