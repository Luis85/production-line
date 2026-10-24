import { open, mkdir, lstat, rename, link, unlink } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readBoundedFile } from '../journal/files.js';

interface FeatureWriteOptions { link?: typeof link; /** Worker-owned rewrites pass false: a displaced copy still byte-identical to `expected` is dropped after publication. */ keepDisplaced?: boolean; }

/** Capture the displaced inode before publication, retaining even a late editor save for recovery. */
export async function replaceFeatureFile(path: string, expected: string, replacement: string, recoveryDirectory: string, options: FeatureWriteOptions = {}): Promise<boolean> {
  if (await readBoundedFile(path, 65536).catch(error => { if (error.code !== 'ENOENT') throw error; return null; }) !== expected) return false;
  await mkdir(recoveryDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(recoveryDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error('Recovery folder must be a real directory.');
  const token = randomUUID(), saved = join(recoveryDirectory, basename(path) + '.' + token + '.md'), staged = join(dirname(path), '.worker-' + token + '.tmp');
  const probe = join(dirname(path), '.worker-' + token + '.link'), createLink = options.link ?? link;
  let probeCreated = false;
  const handle = await open(staged, 'wx', 0o600);
  try { await handle.writeFile(replacement); await handle.sync(); } finally { await handle.close(); }
  try {
    // Unsupported filesystems must fail before the original note leaves its path.
    try { await createLink(staged, probe); probeCreated = true; }
    catch (cause) { throw new Error('The Feature Request folder cannot create recovery hard links. Use a writable local filesystem with hard-link support; the source note was left unchanged.', { cause }); }
    await unlink(probe); probeCreated = false;
    try { await rename(path, saved); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    if (await readBoundedFile(saved, 65536) !== expected) {
      await createLink(saved, path).catch(error => { if (error.code !== 'EEXIST') throw error; });
      return false;
    }
    try { await createLink(staged, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; await createLink(saved, path).catch(() => {}); throw error; }
    // Nothing an editor wrote is lost when the displaced copy is unchanged; a late save into it stays recoverable.
    if (options.keepDisplaced === false && await readBoundedFile(saved, 65536).catch(() => null) === expected) await unlink(saved).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return true;
  } finally {
    if (probeCreated) await unlink(probe).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await unlink(staged).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
