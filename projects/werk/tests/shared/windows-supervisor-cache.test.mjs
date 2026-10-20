import test from 'node:test';
import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { WindowsSupervisorCache } from '../../src/worker/dist/shared/process/windows-supervisor-cache.js';
import { runProcess } from '../../src/worker/dist/shared/process/launcher.js';

const image = Buffer.from('MZportable supervisor fixture');
const target = 'C:\\Program Files\\Provider\\agent.exe';

async function fixture(t) {
  const previous = process.env.SystemRoot;
  if (process.platform !== 'win32') process.env.SystemRoot = 'C:\\Windows';
  const root = await mkdtemp(join(tmpdir(), 'werk-supervisor-contract-'));
  const workspace = join(root, 'project'), temporary = join(root, 'temporary');
  await Promise.all([mkdir(workspace), mkdir(temporary)]);
  const cache = new WindowsSupervisorCache(temporary), beforeClose = [];
  t.after(async () => {
    try {
      for (const release of beforeClose.reverse()) await release();
      await cache.close(); await rm(root, {recursive:true, force:true});
    }
    finally { if (previous === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previous; }
  });
  return {root, workspace, temporary, cache, beforeClose};
}

async function compileImage(plan) { await writeFile(join(plan.cwd, 'pending.exe'), image); }
function launch(f, cwd = f.workspace) { return f.cache.plan(target, ['a b', '"quoted"', ''], {CHOSEN:'yes'}, cwd); }

// The compiler seam writes a bounded PE-shaped fixture. Portable checks verify cache
// ownership and plans; native Windows tests verify the executable and Job Object.
test('supervisor preparation reuses one private artifact, preserves target arguments, and closes ownership', {timeout:10000}, async t => {
  const f = await fixture(t), calls = [];
  const secret = process.env.WERK_CACHE_TEST_SECRET;
  process.env.WERK_CACHE_TEST_SECRET = 'ambient credential';
  try {
    await f.cache.prepare(async plan => { calls.push(plan); await compileImage(plan); }, f.workspace, t.signal);
  } finally { if (secret === undefined) delete process.env.WERK_CACHE_TEST_SECRET; else process.env.WERK_CACHE_TEST_SECRET = secret; }
  await f.cache.prepare(async plan => { calls.push(plan); await compileImage(plan); }, f.workspace, t.signal);
  assert.equal(calls.length, 1);
  const compiled = calls[0];
  assert.equal(compiled.executable, win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  assert.equal(compiled.env.WERK_CACHE_TEST_SECRET, undefined, 'compiler does not inherit arbitrary parent credentials');
  assert.equal(compiled.env.WERK_SUPERVISOR_CACHE, compiled.cwd);
  assert.equal(compiled.env.TEMP, compiled.cwd);
  assert.notEqual(compiled.cwd, f.workspace);
  const env = {CHOSEN:'yes', PathExt:'.EXE;.CMD', werk_provider_launch:'forged', Werk_Supervisor_Cache:'forged cache'};
  const plan = f.cache.plan(target, ['a b', '"quoted"', ''], env, f.workspace);
  assert.ok(plan);
  assert.deepEqual(plan.args, ['werk-supervisor-v1', 'argv', target, 'a b', '"quoted"', '']);
  assert.deepEqual(plan.env, {CHOSEN:'yes', PathExt:'.EXE;.CMD'});
  assert.equal(env.werk_provider_launch, 'forged', 'planning does not mutate the caller environment');
  const next = f.cache.plan(target, [], {NEXT:'isolated'}, f.workspace);
  assert.ok(next); assert.deepEqual(next.env, {NEXT:'isolated'}, 'each invocation receives only its own environment');
  assert.deepEqual(await readFile(plan.executable), image);
  assert.equal((await lstat(plan.executable)).isFile(), true);
  await f.cache.close();
  assert.equal(launch(f), undefined);
  assert.deepEqual(await readdir(f.temporary), []);
  await f.cache.prepare(async plan => { calls.push(plan); await compileImage(plan); }, f.workspace, t.signal);
  assert.equal(calls.length, 1, 'closed cache must not reopen');
});

test('independent cache owners never adopt an earlier executable', {timeout:10000}, async t => {
  const f = await fixture(t), other = new WindowsSupervisorCache(f.temporary);
  f.beforeClose.push(() => other.close());
  await f.cache.prepare(compileImage, f.workspace, t.signal);
  let calls = 0;
  await other.prepare(async plan => { calls++; await compileImage(plan); }, f.workspace, t.signal);
  const first = launch(f), second = other.plan(target, [], {}, f.workspace);
  assert.ok(first); assert.ok(second);
  assert.equal(calls, 1);
  assert.notEqual(first.executable, second.executable);
  await other.close();
  assert.deepEqual(await readFile(first.executable), image, 'closing another owner preserves this artifact');
});

for (const mutation of ['contents', 'identity', 'hard link']) {
  test(`a changed supervisor ${mutation} permanently selects the safe fallback`, {timeout:10000}, async t => {
    const f = await fixture(t);
    await f.cache.prepare(compileImage, f.workspace, t.signal);
    const plan = launch(f); assert.ok(plan);
    if (mutation === 'contents') {
      const changed = Buffer.from(image); changed[changed.length - 1] ^= 1;
      await writeFile(plan.executable, changed);
    } else if (mutation === 'identity') {
      const replacement = join(f.temporary, 'replacement.exe');
      await writeFile(replacement, image);
      await rm(plan.executable);
      await rename(replacement, plan.executable);
    } else await link(plan.executable, join(f.root, 'outside-hardlink.exe'));
    assert.equal(launch(f), undefined);
    let retries = 0;
    await f.cache.prepare(async plan => { retries++; await compileImage(plan); }, f.workspace, t.signal);
    assert.equal(retries, 0, 'tamper must not silently trust a replacement');
    assert.equal(launch(f), undefined);
    assert.deepEqual(await readdir(f.temporary), []);
    if (mutation === 'hard link') assert.deepEqual(await readFile(join(f.root, 'outside-hardlink.exe')), image);
  });
}

test('cleanup never removes a replacement directory at the old cache path', {timeout:10000}, async t => {
  const f = await fixture(t);
  await f.cache.prepare(compileImage, f.workspace, t.signal);
  const plan = launch(f); assert.ok(plan);
  const directory = dirname(plan.executable), moved = join(f.temporary, 'moved-original');
  await rename(directory, moved);
  await mkdir(directory);
  await writeFile(join(directory, 'sentinel.txt'), 'unowned replacement');
  await writeFile(join(directory, 'supervisor.exe'), image);
  assert.equal(launch(f), undefined);
  await f.cache.close();
  assert.equal(await readFile(join(directory, 'sentinel.txt'), 'utf8'), 'unowned replacement');
  assert.deepEqual(await readFile(join(moved, 'supervisor.exe')), image);
});

for (const output of ['missing', 'invalid', 'oversized', 'compiler failure']) {
  test(`bootstrap ${output} leaves no reusable executable and does not repeat compilation`, {timeout:10000}, async t => {
    const f = await fixture(t); let calls = 0;
    await f.cache.prepare(async plan => {
      calls++;
      if (output === 'compiler failure') throw Error('Compiler unavailable');
      if (output !== 'missing') await writeFile(join(plan.cwd, 'pending.exe'), output === 'oversized' ? Buffer.alloc(4 * 1024 * 1024 + 1) : Buffer.from('not PE'));
    }, f.workspace, t.signal);
    assert.equal(launch(f), undefined);
    assert.deepEqual(await readdir(f.temporary), []);
    await f.cache.prepare(() => { calls++; return Promise.resolve(); }, f.workspace, t.signal);
    assert.equal(calls, 1, 'an unavailable optimization retains the original contained launcher');
  });
}

test('cache preparation and later planning reject project overlap', {timeout:10000}, async t => {
  const f = await fixture(t), nested = new WindowsSupervisorCache(f.workspace);
  f.beforeClose.push(() => nested.close());
  let nestedCompiles = 0;
  await nested.prepare(async plan => { nestedCompiles++; await compileImage(plan); }, f.workspace, t.signal);
  assert.equal(nestedCompiles, 0, 'compiler must not run inside a project');
  assert.equal(nested.plan(target, [], {}, f.workspace), undefined);
  assert.deepEqual(await readdir(f.workspace), []);
  await f.cache.prepare(compileImage, f.workspace, t.signal);
  assert.ok(launch(f));
  assert.equal(launch(f, f.root), undefined, 'a later broader project cannot encompass the cache');
});

test('a missing initial working directory skips compilation without disabling future preparation', {timeout:10000}, async t => {
  const f = await fixture(t); let calls = 0;
  const compiler = async plan => { calls++; await compileImage(plan); };
  await f.cache.prepare(compiler, join(f.root, 'missing-project'), t.signal);
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(f.temporary), []);
  await f.cache.prepare(compiler, f.workspace, t.signal);
  assert.equal(calls, 1); assert.ok(launch(f));
});

test('a missing invocation directory does not discard a valid cached supervisor', {timeout:10000}, async t => {
  const f = await fixture(t); let calls = 0;
  const compiler = async plan => { calls++; await compileImage(plan); };
  await f.cache.prepare(compiler, f.workspace, t.signal);
  const original = launch(f); assert.ok(original);
  assert.equal(launch(f, join(f.root, 'missing-project')), undefined);
  await f.cache.prepare(compiler, f.workspace, t.signal);
  const next = launch(f); assert.ok(next);
  assert.equal(next.executable, original.executable);
  assert.equal(calls, 1, 'invalid caller cwd does not trigger compilation or poison shared ownership');
});

test('concurrent preparation compiles once and one cancelled waiter cannot stop another', {timeout:10000}, async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const cancel = new AbortController(), reason = Error('first requester cancelled'); let calls = 0;
  f.beforeClose.push(() => release.resolve());
  const first = f.cache.prepare(async (plan, signal) => { calls++; entered.resolve(signal); await release.promise; await compileImage(plan); }, f.workspace, cancel.signal);
  const rejected = assert.rejects(first, error => error === reason);
  const compilerSignal = await entered.promise;
  const second = f.cache.prepare(() => assert.fail('Concurrent caller must share bootstrap'), f.workspace, t.signal);
  cancel.abort(reason);
  await rejected;
  assert.equal(compilerSignal.aborted, false, 'compiler remains owned by the surviving waiter');
  release.resolve(); await second;
  assert.equal(calls, 1); assert.ok(launch(f));
});

test('a waiting caller deadline expires without cancelling another caller bootstrap', {timeout:10000}, async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.beforeClose.push(() => release.resolve());
  const owner = f.cache.prepare(async (plan, signal) => { entered.resolve(signal); await release.promise; await compileImage(plan); }, f.workspace, t.signal);
  const compilerSignal = await entered.promise;
  // AbortSignal.timeout uses an unref timer; keep this isolated awaited fixture alive.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(f.cache.prepare(() => assert.fail('Deadline waiter must share bootstrap'), f.workspace, AbortSignal.timeout(25)), {name:'TimeoutError'});
    assert.equal(compilerSignal.aborted, false);
  } finally { clearInterval(keepAlive); release.resolve(); }
  await owner; assert.ok(launch(f));
});

test('the final cancelled waiter owns compiler termination and cleanup before it rejects', {timeout:10000}, async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), aborted = Promise.withResolvers(), stopped = Promise.withResolvers();
  const cancel = new AbortController(), reason = Error('all callers cancelled'); let settled = false;
  f.beforeClose.push(() => stopped.resolve());
  const preparing = f.cache.prepare(async (_plan, signal) => {
    signal.addEventListener('abort', () => aborted.resolve(), {once:true});
    entered.resolve(); await stopped.promise;
  }, f.workspace, cancel.signal).finally(() => { settled = true; });
  const rejected = assert.rejects(preparing, error => error === reason);
  await entered.promise; cancel.abort(reason); await aborted.promise;
  assert.equal(settled, false, 'waiter must await compiler termination instead of abandoning it');
  stopped.resolve(); await rejected;
  assert.equal(launch(f), undefined);
  assert.deepEqual(await readdir(f.temporary), []);
  await f.cache.prepare(compileImage, f.workspace, t.signal);
  assert.ok(launch(f), 'a cancelled warmup can be retried by a later caller');
});

test('a new caller during cancelled bootstrap cleanup waits and prepares a fresh artifact', {timeout:10000}, async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), aborted = Promise.withResolvers(), stopped = Promise.withResolvers();
  const cancel = new AbortController(), reason = Error('old caller cancelled');
  let oldStopped = false, calls = 0;
  f.beforeClose.push(() => stopped.resolve());
  const first = f.cache.prepare(async (_plan, signal) => {
    calls++;
    signal.addEventListener('abort', () => aborted.resolve(), {once:true});
    entered.resolve(); await stopped.promise; oldStopped = true;
  }, f.workspace, cancel.signal);
  const rejected = assert.rejects(first, error => error === reason);
  await entered.promise; cancel.abort(reason); await aborted.promise;
  const second = f.cache.prepare(async plan => {
    calls++; assert.equal(oldStopped, true, 'replacement compilation cannot overlap the aborted owner');
    assert.equal((await readdir(f.temporary)).length, 1, 'the old partial cache was removed before replacement');
    await compileImage(plan);
  }, f.workspace, t.signal);
  assert.equal(calls, 1, 'new caller must await old compiler cleanup');
  stopped.resolve(); await Promise.all([rejected, second]);
  assert.equal(calls, 2); assert.ok(launch(f));
});

test('closing during bootstrap waits for compiler termination and prevents later reuse', {timeout:10000}, async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), aborted = Promise.withResolvers(), stopped = Promise.withResolvers();
  let closed = false;
  f.beforeClose.push(() => stopped.resolve());
  const preparing = f.cache.prepare(async (_plan, signal) => {
    signal.addEventListener('abort', () => aborted.resolve(), {once:true});
    entered.resolve(); await stopped.promise;
  }, f.workspace, t.signal);
  await entered.promise;
  const closing = f.cache.close().then(() => { closed = true; });
  await aborted.promise;
  assert.equal(closed, false, 'close retains ownership until compilation has stopped');
  stopped.resolve(); await Promise.all([preparing, closing]);
  assert.equal(launch(f), undefined);
  assert.deepEqual(await readdir(f.temporary), []);
  let retries = 0;
  await f.cache.prepare(async plan => { retries++; await compileImage(plan); }, f.workspace, t.signal);
  assert.equal(retries, 0, 'explicit close is terminal');
});

test('an already cancelled request never allocates a cache or invokes its compiler', {timeout:10000}, async t => {
  const f = await fixture(t), reason = Error('already cancelled');
  let calls = 0;
  await assert.rejects(f.cache.prepare(async plan => { calls++; await compileImage(plan); }, f.workspace, AbortSignal.abort(reason)), error => error === reason);
  assert.equal(calls, 0, 'a cancelled request cannot compile');
  assert.deepEqual(await readdir(f.temporary), []);
  await f.cache.prepare(compileImage, f.workspace, t.signal);
  assert.ok(launch(f), 'a request cancelled before admission does not disable the cache');
});


test('real process exit synchronously aborts unfinished compilation and removes only its owned cache', {timeout:10000}, async t => {
  const f = await fixture(t), marker = join(f.root, 'compiler-aborted.json');
  const unowned = join(f.temporary, 'unowned');
  await mkdir(unowned); await writeFile(join(unowned, 'keep.txt'), 'neighbor survives');
  const module = new URL('../../src/worker/dist/shared/process/windows-supervisor-cache.js', import.meta.url).href;
  const script = `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const [module, temporary, workspace, marker] = process.argv.slice(1);
    const { WindowsSupervisorCache } = await import(module);
    const cache = new WindowsSupervisorCache(temporary);
    void cache.prepare((plan, signal) => {
      writeFileSync(join(plan.cwd, 'unfinished.exe'), 'partial compiler output');
      signal.addEventListener('abort', () => writeFileSync(marker, JSON.stringify({directory:plan.cwd, aborted:signal.aborted})), {once:true});
      setImmediate(() => process.exit(0));
      return new Promise(() => {});
    }, workspace, new AbortController().signal);
  `;
  const result = await runProcess(process.execPath, ['--input-type=module', '-e', script, module, f.temporary, f.workspace, marker], {
    env:{...process.env}, mode:'plain', signal:t.signal, timeoutMs:5000, maxOutputBytes:4096, captureStderr:true
  });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  const aborted = JSON.parse(await readFile(marker, 'utf8'));
  assert.equal(aborted.aborted, true, 'the real exit hook must abort compilation before Node exits');
  await assert.rejects(lstat(aborted.directory), {code:'ENOENT'});
  assert.deepEqual(await readdir(f.temporary), ['unowned']);
  assert.equal(await readFile(join(unowned, 'keep.txt'), 'utf8'), 'neighbor survives');
});
