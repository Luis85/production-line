import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyRelease(root) {
  if (!(await lstat(root)).isDirectory()) throw Error('Release root must be a regular directory');
  const actual = new Set();
  let totalBytes = 0;
  async function inspect(path = '') {
    for (const name of await readdir(join(root, path))) {
      const relative = path ? `${path}/${name}` : name;
      const stat = await lstat(join(root, relative));
      if (stat.isSymbolicLink()) throw Error(`Unexpected symbolic link: ${relative}`);
      if (stat.isDirectory()) await inspect(relative);
      else {
        if (!stat.isFile()) throw Error(`Unexpected nonregular release entry: ${relative}`);
        actual.add(relative);
        totalBytes += stat.size;
        if (stat.size > 32 * 1024 * 1024 || totalBytes > 256 * 1024 * 1024 || actual.size > 10001) throw Error('Release exceeds verification bounds');
      }
    }
  }
  // Inspect every entry before opening any payload (including the manifest).
  await inspect();
  async function readRegular(path) {
    const handle = await open(join(root, path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw Error(`Unexpected nonregular or oversized release entry: ${path}`);
      return await handle.readFile();
    } finally { await handle.close(); }
  }
  if (!actual.has('release-manifest.json')) throw Error('Missing release manifest');
  const manifest = JSON.parse(await readRegular('release-manifest.json'));
  if (manifest.schemaVersion !== 1 || manifest.name !== 'werk' || !Array.isArray(manifest.files)) throw Error('Invalid release manifest');
  const expected = new Set(['release-manifest.json']);
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || /[:\\\x00-\x1f]/.test(file.path) || file.path.startsWith('/') || file.path.split('/').some(part => !part || part === '.' || part === '..') || expected.has(file.path)) throw Error('Invalid or duplicate manifest path');
    if (!actual.has(file.path)) throw Error(`Missing release entry: ${file.path}`);
    expected.add(file.path);
    const content = await readRegular(file.path);
    if (content.length !== file.bytes || createHash('sha256').update(content).digest('hex') !== file.sha256) throw Error(`Release integrity mismatch: ${file.path}`);
  }
  for (const path of actual) if (!expected.has(path)) throw Error(`Unexpected release entry: ${path}`);
  return { version: manifest.version, files: manifest.files.length, sourceCommit: manifest.sourceCommit };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw Error('Usage: node scripts/release/verify.mjs <fresh-extracted-root>');
    console.log(JSON.stringify(await verifyRelease(resolve(process.argv[2]))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
