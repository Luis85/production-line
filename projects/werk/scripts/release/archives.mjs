import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { create } from 'tar';
import { zipSync } from 'fflate';

// Keep packaging policy separate from the maintained archive format implementations.
export async function createArchives(entries) {
  if (entries.length > 10000) throw Error('Release exceeds 10,000 files');
  let bytes = 0;
  const names = new Set();
  for (const entry of entries) {
    if (/[:\\\x00-\x1f\x7f]/.test(entry.path) || entry.path.startsWith('/') || entry.path.split('/').some(part => !part || part === '.' || part === '..')) throw Error(`Unsafe archive path: ${entry.path}`);
    if (names.has(entry.path)) throw Error(`Duplicate archive path: ${entry.path}`);
    names.add(entry.path);
    bytes += entry.content.length;
    if (bytes > 256 * 1024 * 1024) throw Error('Release contents exceed the 256 MiB packaging limit');
  }
  const staging = await mkdtemp(join(tmpdir(), 'werk-package-'));
  try {
    const zipFiles = Object.create(null);
    const modes = new Map();
    for (const entry of entries) {
      const path = join(staging, entry.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, entry.content, { mode: entry.mode, flag: 'wx' });
      modes.set(entry.path, entry.mode);
      zipFiles[entry.path] = [entry.content, { os: 3, attrs: ((0o100000 | entry.mode) << 16) >>> 0, mtime: new Date(1980, 0, 1) }];
    }
    const archive = join(staging, 'archive.tar.gz');
    await create({ cwd: staging, file: archive, gzip: true, portable: true, noMtime: true, onWriteEntry(entry) { entry.stat.mode = modes.get(entry.path); } }, entries.map(entry => entry.path));
    return { tarGzip: await readFile(archive), zip: Buffer.from(zipSync(zipFiles, { level: 6 })) };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
