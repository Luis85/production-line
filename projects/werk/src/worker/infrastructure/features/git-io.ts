import { gitExecutable } from '../../../shared/git/executable.js';
import { gitLaunchMode } from '../../../shared/git/launch-mode.js';
import { gitEnvironment } from '../../../shared/git/environment.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep, win32 } from 'node:path';
import { runProcess, ProcessRunError } from '../../../shared/process/launcher.js';
import { repositoryRoot, repositoryWorktreeArgument, type RepositoryRoot } from '../repositories-git.js';

export class GitFeatureError extends Error {
  readonly code: 'conflict' | 'invalid_input' | 'unavailable' | 'cancelled';
  constructor(code: GitFeatureError['code'], message: string) { super(message); this.code = code; }
}
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const commitId = (text: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(text);
export function gitPath(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..' || /^\.git$/i.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
    throw new GitFeatureError('invalid_input', 'Use a portable repository-relative path without Git control metadata.');
  return value;
}
export function branchName(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 200 || value === '@' || value.startsWith('-') || /[\x00-\x20\x7f~^:?*\[\\]/.test(value) || value.includes('..') || value.includes('@{') || value.endsWith('.') || value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock')))
    throw new GitFeatureError('invalid_input', 'Use a valid shared Git branch name.');
  return value;
}
export function textBytes(value: string, limit: number) {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > limit || Buffer.from(value).toString('utf8') !== value)
    throw new GitFeatureError('invalid_input', 'Shared feature content must be bounded UTF-8 text.');
}
export async function ordinaryDirectory(value: string, create = false) {
  const absolute = resolve(value), root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (create) await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new GitFeatureError('conflict', 'Shared feature storage must use ordinary directories.');
  }
  if (await realpath(absolute) !== absolute) throw new GitFeatureError('conflict', 'Shared feature storage identity changed.');
  return absolute;
}
async function publicationDirectory(storage: string, signal: AbortSignal) {
  // Windows' temporary-directory API has a shorter path limit than mkdir.
  // Keep the suffix bounded and create exclusively; never adopt a collision.
  for (let attempt = 0; attempt < 8; attempt++) {
    signal.throwIfAborted();
    const path = join(storage, 'p-' + randomBytes(6).toString('base64url').slice(0, 6));
    try { await mkdir(path, { mode: 0o700 }); return path; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  throw new GitFeatureError('unavailable', 'Unable to reserve a private publication worktree. Retry publication.');
}
/**
 * Git for Windows' `worktree remove` follows NTFS junctions inside the worktree and
 * deletes the target's files. Remove each link entry itself, never descending into
 * one, so Git only deletes ordinary entries. Returns the number of links removed, or
 * null when the walk exceeds its bound or a link survives removal.
 * Task worktree removal refuses links instead (`linkFree` in repositories-git.ts).
 */
export async function removeLinks(path: string, limit = 500000): Promise<number | null> {
  const pending = [path];
  let entries = 0, removed = 0;
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (++entries > limit) return null;
      if (entry.isFile()) continue;
      const child = join(current, entry.name), info = await lstat(child);
      if (!info.isSymbolicLink()) { if (info.isDirectory()) pending.push(child); continue; }
      // rmdir removes a junction or directory link itself and never a populated directory.
      await unlink(child).catch(() => rmdir(child)).catch(() => {});
      if (await lstat(child).then(() => true, () => false)) return null;
      removed++;
    }
  }
  return removed;
}
const retainedReason = 'Werk kept this publication worktree because it contains symbolic links or junctions it could not safely remove. Delete the links themselves, then remove the worktree.';
export interface GitBlob { revision: string; content: string; mode: string; }
export interface GitIoOptions { repository: string; remote: string; stateDirectory: string; }
/**
 * Git opens worktree metadata before long-path configuration and bounds a child's
 * GIT_DIR to 220 UTF-8 bytes on Windows; a relative argument preserves the same path.
 * Checked when shared intake is configured so a deep state directory fails before any claim.
 */
export function assertPublicationPath(stateDirectory: string, repository: string, platform: NodeJS.Platform = process.platform) {
  if (platform !== 'win32') return;
  const candidate = win32.join(stateDirectory, 'worktrees', 'p-XXXXXX');
  const metadataPath = win32.join(candidate, '.git'), gitDir = win32.join(repositoryWorktreeArgument(repository, candidate, win32), '.git');
  const limits: string[] = [];
  if (metadataPath.length >= 260) limits.push('the absolute metadata path has ' + metadataPath.length + ' characters and must have fewer than 260');
  if (Buffer.byteLength(gitDir) > 220) limits.push('the Git worktree argument uses ' + Buffer.byteLength(gitDir) + ' UTF-8 bytes and must use at most 220');
  if (limits.length) throw new GitFeatureError('invalid_input', 'Use a shorter worker state directory for shared feature publication on Windows: ' + limits.join('; ') + '. Start the worker with a shorter --state-dir, for example C:\\werk\\project.');
}
/** Git reads objects and writes only worker-owned temporary worktrees; it never checks out the developer branch. */
export class FeatureGitIo {
  readonly options: GitIoOptions;
  constructor(options: GitIoOptions) {
    if (!isAbsolute(options.repository) || !isAbsolute(options.stateDirectory) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.remote) || options.remote.endsWith('.lock') || options.remote.includes('..')) throw new GitFeatureError('invalid_input', 'Shared features require an absolute repository, private state directory and named Git remote.');
    this.options = { ...options, repository: resolve(options.repository), stateDirectory: resolve(options.stateDirectory) };
  }
  async root(signal: AbortSignal): Promise<RepositoryRoot> {
    try { return await repositoryRoot(this.options.repository, signal); }
    catch { throw new GitFeatureError(signal.aborted ? 'cancelled' : 'unavailable', 'Shared feature repository is unavailable. Check its path and Git configuration.'); }
  }
  async git(cwd: string, args: string[], signal: AbortSignal, input?: string, allowNonZeroExit = false) {
    const mode = gitLaunchMode(args);
    const env = { ...gitEnvironment(mode === 'plain' ? 'host-local' : 'host'), GIT_AUTHOR_NAME: 'Werk Worker', GIT_AUTHOR_EMAIL: 'worker@werk.invalid', GIT_COMMITTER_NAME: 'Werk Worker', GIT_COMMITTER_EMAIL: 'worker@werk.invalid' };
    try {
      return await runProcess(await gitExecutable(cwd, env, mode), ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'core.longpaths=true', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'submodule.recurse=false', '-c', 'protocol.ext.allow=never', '-c', 'commit.gpgSign=false', ...args], { cwd, env, mode, observation: { kind: 'git', label: 'Git operation' }, signal, input, timeoutMs: 30000, maxOutputBytes: 2 * 1024 * 1024, allowNonZeroExit });
    } catch (error) {
      throw new GitFeatureError(signal.aborted || error instanceof ProcessRunError && error.reason === 'cancelled' ? 'cancelled' : 'unavailable', 'Shared feature Git operation failed. Check connectivity, host Git authentication and repository permissions.');
    }
  }
  async output(cwd: string, args: string[], signal: AbortSignal, input?: string) {
    const result = await this.git(cwd, args, signal, input);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout); }
    catch { throw new GitFeatureError('conflict', 'Shared Git content must be valid UTF-8.'); }
  }
  async fetch(root: RepositoryRoot, branch: string, signal: AbortSignal, missing = false): Promise<string | null> {
    branchName(branch);
    if (missing && !(await this.output(root.path, ['ls-remote', '--refs', '--', this.options.remote, `refs/heads/${branch}`], signal)).trim()) return null;
    // An invocation-specific ref avoids racing the repository watcher's FETCH_HEAD.
    const ref = `refs/werk/features/fetch-${randomUUID()}`;
    try {
      await this.output(root.path, ['fetch', '--no-write-fetch-head', '--no-recurse-submodules', '--no-tags', '--', this.options.remote, `refs/heads/${branch}:${ref}`], signal);
      const head = (await this.output(root.path, ['rev-parse', '--verify', `${ref}^{commit}`], signal)).trim();
      if (!commitId(head)) throw new GitFeatureError('conflict', 'Shared branch did not resolve to a commit.');
      return head;
    } finally {
      await this.git(root.path, ['update-ref', '-d', ref], AbortSignal.timeout(5000), undefined, true).catch(() => {});
    }
  }
  async blob(root: RepositoryRoot, commit: string, path: string, signal: AbortSignal, limit = 65536): Promise<GitBlob | null> {
    if (!commitId(commit)) throw new GitFeatureError('invalid_input', 'Read shared feature content at a full commit identifier.');
    gitPath(path);
    const raw = await this.output(root.path, ['ls-tree', '-z', commit, '--', path], signal);
    if (!raw) return null;
    const entries = raw.split('\0').filter(Boolean), match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(entries[0] ?? '');
    if (entries.length !== 1 || !match || match[3] !== path) throw new GitFeatureError('conflict', 'Shared feature files must be regular tracked files, not directories or symlinks.');
    const size = Number((await this.output(root.path, ['cat-file', '-s', match[2]!], signal)).trim());
    if (!Number.isSafeInteger(size) || size > limit) throw new GitFeatureError('conflict', 'Shared feature file exceeds its size limit.');
    const content = await this.output(root.path, ['cat-file', 'blob', match[2]!], signal);
    textBytes(content, limit);
    return { revision: hash(content), content, mode: match[1]! };
  }
  async worktree<T>(root: RepositoryRoot, commit: string, signal: AbortSignal, action: (path: string) => Promise<T>): Promise<T> {
    if (!commitId(commit)) throw new GitFeatureError('invalid_input', 'Publication requires a full source commit identifier.');
    const directory = join(this.options.stateDirectory, 'worktrees');
    assertPublicationPath(this.options.stateDirectory, root.path);
    const storage = await ordinaryDirectory(directory, true);
    const path = await publicationDirectory(storage, signal), identity = await lstat(path);
    let added = false;
    try {
      await this.output(root.path, ['worktree', 'add', '--detach', '--', repositoryWorktreeArgument(root.path, path), commit], signal); added = true;
      if ((await this.output(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal)).length) throw new GitFeatureError('conflict', 'Publication worktree is not clean.');
      return await action(path);
    } finally {
      const actual = await lstat(path).catch(() => null);
      if (added && actual?.isDirectory() && !actual.isSymbolicLink() && actual.dev === identity.dev && actual.ino === identity.ino && actual.birthtimeMs === identity.birthtimeMs && await realpath(path) === path)
        await this.removeWorktree(root, path);
    }
  }
  /** Best-effort cleanup that never deletes outside the worktree; an unsafe worktree stays locked with a reason. */
  private async removeWorktree(root: RepositoryRoot, path: string) {
    let linkFree = false;
    try {
      // A further pass confirms that nothing recreated a link after the previous one.
      for (let pass = 0; pass < 3 && !linkFree; pass++) {
        const removed = await removeLinks(path);
        if (removed === null) break;
        linkFree = removed === 0;
      }
    } catch {}
    const args = linkFree ? ['worktree', 'remove', '--force', '--', path] : ['worktree', 'lock', '--reason', retainedReason, '--', path];
    await this.git(root.path, args, AbortSignal.timeout(10000), undefined, true).catch(() => {});
  }
  async write(worktree: string, path: string, content: string, mode: string, signal: AbortSignal) {
    const parts = gitPath(path).split('/');
    // Reject aliases before touching a case-insensitive filesystem; a new Git path
    // must not replace an existing developer file with different capitalization.
    let parent = worktree;
    for (const [index, part] of parts.entries()) {
      const names = await readdir(parent);
      if (names.some(name => name !== part && name.normalize('NFC').toLowerCase() === part.normalize('NFC').toLowerCase())) throw new GitFeatureError('conflict', 'Publication path collides with an existing filename.');
      if (index < parts.length - 1) parent = await ordinaryDirectory(join(parent, part), true);
    }
    const target = join(worktree, ...parts), current = await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (current && (!current.isFile() || current.isSymbolicLink())) throw new GitFeatureError('conflict', 'Publication cannot replace a directory or symlink.');
    const handle = await open(target, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW, mode === '100755' ? 0o700 : 0o600);
    try { await handle.writeFile(content); } finally { await handle.close(); }
    // Stage exact bytes: host clean filters and line-ending conversion must not change the claimed input.
    const blob = (await this.output(worktree, ['hash-object', '-w', '--stdin', '--no-filters'], signal, content)).trim();
    await this.output(worktree, ['update-index', '--add', '--cacheinfo', mode, blob, path], signal);
  }
  async commit(worktree: string, parent: string, operationId: string, digest: string, signal: AbortSignal) {
    const tree = (await this.output(worktree, ['write-tree'], signal)).trim();
    return (await this.output(worktree, ['commit-tree', tree, '-p', parent], signal, `Werk feature publication\n\nWerk-Operation: ${operationId}\nWerk-Payload: ${digest}\n`)).trim();
  }
  async push(root: RepositoryRoot, commit: string, branch: string, signal: AbortSignal) {
    const result = await this.git(root.path, ['push', '--porcelain', '--no-verify', '--no-follow-tags', '--', this.options.remote, `${commit}:refs/heads/${branchName(branch)}`], signal, undefined, true);
    return result.exitCode === 0;
  }
}
