import { constants } from 'node:fs';
import { open, rename, unlink, mkdir, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Publish complete files atomically and sync their contents before acknowledging persistence. */
export async function atomicWrite(path: string, body: string, mode = 0o600): Promise<void> {
  await assertDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', mode);
  try {
    await file.writeFile(body);
    await file.sync();
    await file.close();
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await file.close().catch(() => {});
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

/** State folders must be real directories; do not follow pre-existing journal symlinks. */
export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertDirectory(path);
}

export async function assertDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Worker state directory must not be a symlink');
}

/** Read at most limit + 1 bytes, even if another process grows the file after stat. */
export async function readBoundedFile(path: string, limit: number): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw Error('Worker state file must be a regular file, not a symlink');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const current = await file.stat();
    if (!current.isFile()) throw Error('Worker state file must be a regular file');
    if (current.size > limit) throw Error(`Worker state file exceeds ${limit} bytes`);
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) return buffer.subarray(0, size).toString('utf8');
      size += bytesRead;
    }
    throw Error(`Worker state file exceeds ${limit} bytes`);
  } finally { await file.close(); }
}

/** Persist directory-entry changes before removing a recovery checkpoint. */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
