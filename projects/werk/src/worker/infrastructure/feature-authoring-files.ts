import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

/** Revision of an authoring file as read: SHA-256 of its UTF-8 text. */
export const authoringRevision = (text: string) => createHash('sha256').update(text).digest('hex');

/** Authoring never follows repository links, including a symlinked parent directory. */
export async function authoringPath(root: string, path: string, createParents = false): Promise<string> {
  if (!path || path.includes('\\') || path.startsWith('/') || /^[a-z]:/i.test(path) || /[\x00-\x1f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) throw Error('Use a contained project-relative path.');
  const target = resolve(root, path);
  if (relative(root, target).startsWith('..')) throw Error('Path must remain inside the project.');
  let current = root;
  const parts = path.split('/');
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    let info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!info && createParents) { await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; }); info = await lstat(current); }
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw Error('Authoring paths must use real project directories.');
  }
  return target;
}

export async function readAuthoringFile(root: string, path: string, limit = 65536): Promise<string | undefined> {
  const target = await authoringPath(root, path);
  const info = await lstat(target).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit) throw Error('Authoring files must be bounded regular files without links.');
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > limit) throw Error('Authoring file changed while being read.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: Math.min(limit + 1, 65536) })) {
      size += chunk.length;
      if (size > limit) throw Error('Authoring file exceeds its size limit.');
      chunks.push(chunk);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
  } finally { await handle.close(); }
}

export async function seedAuthoringFile(root: string, path: string, content: string): Promise<'created' | 'preserved'> {
  if (await readAuthoringFile(root, path, 2097152) !== undefined) return 'preserved';
  const target = await authoringPath(root, path, true);
  let handle;
  try { handle = await open(target, 'wx', 0o644); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') { await readAuthoringFile(root, path, 2097152); return 'preserved'; } throw error; }
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  return 'created';
}

/** Atomically replaces an existing file only while it still has the revision the caller inspected. */
export async function replaceAuthoringFile(root: string, path: string, content: string, expectedRevision: string): Promise<'updated'> {
  const target = await authoringPath(root, path);
  const temporary = join(dirname(target), '._authoring-' + randomUUID() + '.tmp');
  const handle = await open(temporary, 'wx', 0o644);
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try {
    const observed = await readAuthoringFile(root, path, 2097152);
    if (observed === undefined || authoringRevision(observed) !== expectedRevision) throw Error('An authoring file changed during setup. Inspect it before retrying.');
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => {}); }
  return 'updated';
}

export async function authoringRoot(directory: string): Promise<string> {
  const root = await realpath(directory);
  if (!(await lstat(root)).isDirectory()) throw Error('Project root must be a directory.');
  return root;
}
