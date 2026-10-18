import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanup } from './fixture-cleanup.mjs';
import { runApprovedToolProcess } from '../../src/worker/dist/worker/infrastructure/tool-process.js';
import { ProcessRunError } from '../../src/worker/dist/shared/process/launcher.js';

test('approved tool processes preserve literal arguments, private environment and caller color opt-in', { timeout: 60000 }, async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'werk-tool-process-')));
  cleanup(t, () => rm(cwd, { recursive: true, force: true }));
  const previous = process.env.WERK_TEST_SECRET; process.env.WERK_TEST_SECRET = 'host-only-secret';
  t.after(() => { if (previous === undefined) delete process.env.WERK_TEST_SECRET; else process.env.WERK_TEST_SECRET = previous; });
  const argument = '; echo literal $HOME';
  const script = 'console.log(JSON.stringify({cwd:process.cwd(),arg:process.argv[1],secret:process.env.WERK_TEST_SECRET??null,color:process.env.NO_COLOR??null,force:process.env.FORCE_COLOR??null,term:process.env.TERM??null}));process.stderr.write("child diagnostic");process.exitCode=4';
  for (const disableColor of [false, true]) {
    const result = await runApprovedToolProcess(process.execPath, ['-e', script, argument], { cwd, signal: new AbortController().signal, timeoutMs: 30000, maxOutputBytes: 4096, disableColor });
    assert.equal(result.exitCode, 4, 'nonzero status remains available to the caller');
    assert.equal(result.stderr.toString('utf8'), 'child diagnostic');
    assert.deepEqual(JSON.parse(result.stdout.toString('utf8')), { cwd, arg: argument, secret: null, color: disableColor ? '1' : null, force: disableColor ? '0' : null, term: disableColor ? 'dumb' : null });
  }
});

test('approved tool processes retain the shared launcher failure type and result', async () => {
  await assert.rejects(runApprovedToolProcess(process.execPath, ['-e', 'throw Error("must not start")'], { cwd: process.cwd(), signal: AbortSignal.abort(), timeoutMs: 1000, maxOutputBytes: 4096 }), error => {
    assert.ok(error instanceof ProcessRunError); assert.equal(error.reason, 'cancelled');
    assert.equal(error.result.exitCode, null); assert.equal(error.result.stdout.length, 0); assert.equal(error.result.stderr.length, 0);
    return true;
  });
});

test('approved tool processes receive the worker PATHEXT and ComSpec but no other host variables', { timeout: 60000 }, async t => {
  const saved = { PATHEXT: process.env.PATHEXT, ComSpec: process.env.ComSpec };
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  process.env.PATHEXT = '.EXE;.CMD'; process.env.ComSpec = process.platform === 'win32' ? saved.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh';
  const script = 'process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(pathext|comspec)$/i.test(k)).map(([k,v])=>[k.toLowerCase(),v]))))';
  const result = await runApprovedToolProcess(process.execPath, ['-e', script], { cwd: process.cwd(), signal: new AbortController().signal, timeoutMs: 30000, maxOutputBytes: 4096 });
  assert.deepEqual(JSON.parse(result.stdout.toString('utf8')), { pathext: '.EXE;.CMD', comspec: process.env.ComSpec });
});
