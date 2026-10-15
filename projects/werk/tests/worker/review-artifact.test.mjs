import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyReviewArtifact } from '../../src/worker/dist/worker/infrastructure/review-artifact.js';

async function fixture(t, text) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-review-integrity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'review', 'lease'), { recursive: true });
  const review = { artifactPath: 'review/lease/change.patch', patchBytes: Buffer.byteLength(text), patchSha256: createHash('sha256').update(text).digest('hex') };
  const file = join(directory, review.artifactPath);
  await writeFile(file, text);
  return { directory, review, file };
}

test('review integrity rejects malformed UTF-8 that would otherwise decode to the approved patch', async t => {
  const original = 'diff --git a/file b/file\n+\ufffd\n';
  const f = await fixture(t, original);
  await verifyReviewArtifact(f.directory, 'lease', f.review);
  for (const invalid of [Buffer.from([0xff]), Buffer.from([0xf0, 0x90, 0x80])]) {
    const altered = Buffer.concat([Buffer.from('diff --git a/file b/file\n+'), invalid, Buffer.from('\n')]);
    assert.equal(altered.toString('utf8'), original);
    await writeFile(f.file, altered);
    await assert.rejects(verifyReviewArtifact(f.directory, 'lease', f.review), error => error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA');
  }
});

test('review integrity preserves a valid UTF-8 byte-order mark when verifying exact bytes', async t => {
  const f = await fixture(t, '\ufeffdiff --git a/file b/file\n+Text.\n');
  await verifyReviewArtifact(f.directory, 'lease', f.review);
});
