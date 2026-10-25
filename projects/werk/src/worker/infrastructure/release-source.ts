import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError } from '../../shared/errors.js';

type Git = (args: string[], signal: AbortSignal, cwd?: string) => Promise<string>;
/** Compare raw source bytes to Git blobs; attributes, filters and replace refs cannot manufacture source provenance. */
export async function verifyReleaseSource(git: Git, worktree: string, commit: string, signal: AbortSignal, outputs: string[] = []): Promise<void> {
  if (await git(['rev-parse', '--verify', 'HEAD'], signal, worktree) !== commit) throw new DomainError('conflict', 'The isolated build changed its pinned merged commit.');
  const rows = (await git(['ls-tree', '-rz', '--full-tree', commit], signal, worktree)).split('\0').filter(Boolean);
  if (rows.length > 20000) throw new DomainError('conflict', 'Release source inventory exceeds 20,000 tracked files.');
  async function verify(row: string) {
    signal.throwIfAborted();
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/.exec(row);
    if (!match || /[\x00-\x1f\x7f\ufffd]/.test(match[3]!) || match[3]!.split('/').some(part => !part || part === '.' || part === '..')) throw new DomainError('conflict', 'Release source contains an unsupported Git entry or filename.');
    const [, mode, expected, path] = match;
    if (outputs.includes(path!)) return;
    let current = worktree;
    for (const part of path!.split('/').slice(0, -1)) {
      current = join(current, part); const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new DomainError('conflict', 'Release source traverses an unexpected directory or symbolic link.');
    }
    const filePath = join(worktree, path!), info = await lstat(filePath), algorithm = expected!.length === 40 ? 'sha1' : 'sha256';
    let observed: string;
    if (mode === '120000') {
      if (!info.isSymbolicLink()) throw new DomainError('conflict', 'Release source symbolic link changed after checkout.');
      const target = Buffer.from(await readlink(filePath)); observed = createHash(algorithm).update('blob ' + target.length + '\0').update(target).digest('hex');
    } else {
      if (!info.isFile() || info.isSymbolicLink()) throw new DomainError('conflict', 'Release source file changed after checkout.');
      const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const digest = createHash(algorithm).update('blob ' + info.size + '\0'); let count = 0;
        for await (const chunk of file.createReadStream({ autoClose: false })) { signal.throwIfAborted(); count += chunk.length; if (count > info.size) throw new DomainError('conflict', 'Release source changed during verification.'); digest.update(chunk); }
        if (count !== info.size) throw new DomainError('conflict', 'Release source changed during verification.');
        observed = digest.digest('hex');
      } finally { await file.close(); }
    }
    if (observed !== expected) throw new DomainError('conflict', 'The build source bytes differ from the exact merged commit.');
  }
  for (let offset = 0; offset < rows.length; offset += 8) await Promise.all(rows.slice(offset, offset + 8).map(verify));
}
