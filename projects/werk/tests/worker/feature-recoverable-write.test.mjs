import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { replaceFeatureFile } from '../../src/worker/dist/worker/infrastructure/features/recoverable-write.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-recoverable-write-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'request.md'), recovery = join(directory, '_conflicts');
  await writeFile(path, 'Accepted source');
  return { directory, path, recovery };
}

test('an unsupported hard-link filesystem leaves the source in place before any displacement', async t => {
  const f = await fixture(t);
  await assert.rejects(replaceFeatureFile(f.path, 'Accepted source', 'Worker projection', f.recovery, {
    async link() { throw Object.assign(Error('Hard links are unsupported'), { code: 'ENOTSUP' }); },
  }), /hard-link support.*source note was left unchanged/);
  assert.equal(await readFile(f.path, 'utf8'), 'Accepted source');
  assert.deepEqual(await readdir(f.recovery), [], 'No source was displaced into recovery before filesystem capability was confirmed.');
  assert.deepEqual((await readdir(f.directory)).sort(), ['_conflicts', 'request.md'], 'Probe and staged bytes are removed.');
  assert.equal(await replaceFeatureFile(f.path, 'Accepted source', 'Worker projection', f.recovery), true);
  assert.equal(await readFile(f.path, 'utf8'), 'Worker projection');
});

test('a late editor save wins publication while the accepted source stays recoverable', async t => {
  const f = await fixture(t);
  const replaced = await replaceFeatureFile(f.path, 'Accepted source', 'Worker projection', f.recovery, {
    async link(source, destination) {
      if (destination === f.path) {
        await writeFile(f.path, 'Late author save', { flag: 'wx' });
        throw Object.assign(Error('The editor published first'), { code: 'EEXIST' });
      }
      await link(source, destination);
    },
  });
  assert.equal(replaced, false); assert.equal(await readFile(f.path, 'utf8'), 'Late author save');
  const saved = await readdir(f.recovery); assert.equal(saved.length, 1);
  assert.equal(await readFile(join(f.recovery, saved[0]), 'utf8'), 'Accepted source');
  assert.deepEqual((await readdir(f.directory)).sort(), ['_conflicts', 'request.md']);
});


test('a colliding preflight path is never removed as if the worker owned it', async t => {
  const f = await fixture(t); let collision;
  await assert.rejects(replaceFeatureFile(f.path, 'Accepted source', 'Worker projection', f.recovery, {
    async link(_source, destination) {
      collision = destination;
      await writeFile(destination, 'Concurrent unrelated file', { flag: 'wx' });
      throw Object.assign(Error('Probe path is already occupied'), { code: 'EEXIST' });
    },
  }), /source note was left unchanged/);
  assert.equal(await readFile(f.path, 'utf8'), 'Accepted source');
  assert.equal(await readFile(collision, 'utf8'), 'Concurrent unrelated file');
  assert.deepEqual(await readdir(f.recovery), []);
});
