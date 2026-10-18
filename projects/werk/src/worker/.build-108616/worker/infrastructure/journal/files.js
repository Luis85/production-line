import { constants } from 'node:fs';
import { open, rename, unlink, mkdir, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Filesystem retry progress must not depend on an application's injected or mocked execution clock.
const fileRetryTimer = setTimeout;
const waitForFileRetry = (milliseconds        )                => new Promise(resolve => fileRetryTimer(resolve, milliseconds));
                                 
                             
                                                                  
                                                 
 

async function publish(temporary        , destination        , operations                       )                {
  const replace = operations.rename ?? rename;
  const wait = operations.wait ?? waitForFileRetry;
  const platform = operations.platform ?? process.platform;
  for (let attempt = 0; ; attempt++) {
    try { await replace(temporary, destination); return; }
    catch (error) {
      // Windows readers/antivirus can briefly prevent replacement. Never remove the existing destination.
      const code = (error                         )?.code;
      // Scanners and indexers can hold a fresh file for well over a second; allow ~2.3 s in total.
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 13) throw error;
      await wait(Math.min(10 * 2 ** attempt, 250));
      await assertDirectory(dirname(destination));
    }
  }
}


/** Publish complete files atomically and sync their contents before acknowledging persistence. */
export async function atomicWrite(path        , body        , mode = 0o600, operations                        = {})                {
  await assertDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', mode);
  try {
    await file.writeFile(body);
    await file.sync();
    await file.close();
    await publish(temporary, path, operations);
    await syncDirectory(dirname(path));
  } finally {
    await file.close().catch(() => {});
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

/** State folders must be real directories; do not follow pre-existing journal symlinks. */
export async function ensureDirectory(path        )                {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertDirectory(path);
}

export async function assertDirectory(path        )                {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Worker state directory must not be a symlink');
}

/** Read at most limit + 1 bytes, even if another process grows the file after stat. */
export async function readBoundedFile(path        , limit        , strictUtf8 = false)                  {
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
      if (!bytesRead) {
        const bytes = buffer.subarray(0, size);
        // Integrity callers cannot replace malformed bytes with U+FFFD before hashing.
        return strictUtf8 ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) : bytes.toString('utf8');
      }
      size += bytesRead;
    }
    throw Error(`Worker state file exceeds ${limit} bytes`);
  } finally { await file.close(); }
}

/** Persist directory-entry changes before removing a recovery checkpoint. */
export async function syncDirectory(path        )                {
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
