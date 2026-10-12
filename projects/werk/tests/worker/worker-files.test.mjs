import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, rename, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as turn } from 'node:timers/promises';
import { atomicWrite } from '../../src/worker/dist/worker/infrastructure/journal/files.js';

const ioError = code => Object.assign(new Error(`fixture ${code}`), { code });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-atomic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'status.json');
  await writeFile(path, 'previous complete bytes', { mode: 0o600 });
  return { directory, path };
}

test('Windows publication retries transient rename errors without removing previous bytes', async t => {
  const f = await fixture(t), delays = [], codes = ['EPERM', 'EACCES', 'EBUSY'];
  let calls = 0;
  await atomicWrite(f.path, 'new complete bytes', 0o600, {
    platform: 'win32',
    async rename(source, destination) {
      assert.equal(await readFile(source, 'utf8'), 'new complete bytes');
      assert.equal(await readFile(destination, 'utf8'), 'previous complete bytes');
      if (calls++ < codes.length) throw ioError(codes[calls - 1]);
      await rename(source, destination);
    },
    async wait(milliseconds) { delays.push(milliseconds); assert.equal(await readFile(f.path, 'utf8'), 'previous complete bytes'); }
  });
  assert.equal(calls, 4); assert.deepEqual(delays, [10, 20, 40]);
  assert.equal(await readFile(f.path, 'utf8'), 'new complete bytes');
  assert.deepEqual(await readdir(f.directory), ['status.json']);
  if (process.platform !== 'win32') assert.equal((await stat(f.path)).mode & 0o777, 0o600);
});

test('exhausted Windows publication preserves the previous file and removes only its temporary file', async t => {
  const f = await fixture(t), error = ioError('EPERM'), delays = []; let calls = 0;
  await assert.rejects(atomicWrite(f.path, 'never published', 0o600, {
    platform: 'win32', async rename() { calls++; throw error; }, async wait(ms) { delays.push(ms); }
  }), cause => cause === error);
  assert.equal(calls, 8); assert.deepEqual(delays, [10, 20, 40, 80, 100, 100, 100]);
  assert.equal(await readFile(f.path, 'utf8'), 'previous complete bytes');
  assert.deepEqual(await readdir(f.directory), ['status.json']);
});

test('nontransient failures and POSIX permission failures fail immediately without retries', async t => {
  const f = await fixture(t);
  for (const [platform, code] of [['win32', 'ENOENT'], ['win32', 'EXDEV'], ['win32', 'EIO'], ['linux', 'EPERM'], ['darwin', 'EACCES'], ['linux', 'EBUSY']]) {
    const error = ioError(code); let calls = 0;
    await assert.rejects(atomicWrite(f.path, 'never published', 0o600, {
      platform, async rename() { calls++; throw error; }, async wait() { assert.fail('must not retry'); }
    }), cause => cause === error);
    assert.equal(calls, 1); assert.equal(await readFile(f.path, 'utf8'), 'previous complete bytes');
    assert.deepEqual(await readdir(f.directory), ['status.json']);
  }
});

test('filesystem retries progress while execution timers are frozen', { timeout: 2000 }, async t => {
  const f = await fixture(t); let calls = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await atomicWrite(f.path, 'published without advancing execution time', 0o600, {
    platform: 'win32', async rename(source, destination) { if (calls++ === 0) throw ioError('EBUSY'); await rename(source, destination); }
  });
  assert.equal(calls, 2); assert.equal(await readFile(f.path, 'utf8'), 'published without advancing execution time');
});

test('concurrent readers observe complete files and Windows contention preserves data until release', { timeout: 12000 }, async t => {
  const f = await fixture(t); const payload = 'x'.repeat(8192);
  await atomicWrite(f.path, JSON.stringify({ revision: 0, payload }));
  let stopped = false, observations = 0;
  const readers = Array.from({ length: 3 }, async () => {
    while (!stopped) {
      const handle = await open(f.path, 'r');
      try {
        const value = JSON.parse(await handle.readFile('utf8'));
        assert.equal(value.payload, payload); assert.ok(Number.isInteger(value.revision) && value.revision >= 0 && value.revision <= 40);
        observations++; await turn();
      } finally { await handle.close(); }
      await turn();
    }
  });
  // Settle every reader before cleanup, even if another reader or publication fails.
  const joined = Promise.allSettled(readers);
  let publishedRevision = 0, publicationError;
  try {
    for (let revision = 1; revision <= 40; revision++) {
      await atomicWrite(f.path, JSON.stringify({ revision, payload }));
      publishedRevision = revision;
    }
  } catch (error) { publicationError = error; }
  finally {
    stopped = true;
    const outcomes = await joined;
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  }
  // Windows may retain overlapping reader handles for the whole bounded retry window.
  // Exhaustion must preserve the last complete version; publication succeeds once every reader closes.
  if (publicationError) {
    assert.equal(process.platform, 'win32', 'POSIX publication must succeed with open readers');
    assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(publicationError.code), String(publicationError));
    assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), { revision: publishedRevision, payload });
    assert.deepEqual(await readdir(f.directory), ['status.json']);
    await atomicWrite(f.path, JSON.stringify({ revision: 40, payload }));
  }
  assert.ok(observations > 0); assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), { revision: 40, payload });
  assert.deepEqual(await readdir(f.directory), ['status.json']);
});
