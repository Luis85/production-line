import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export class RepositoryGitError extends Error {
  readonly reason: 'failed' | 'timeout' | 'cancelled';
  constructor(reason: 'failed' | 'timeout' | 'cancelled') {
    super(reason === 'cancelled' ? 'Repository operation cancelled.' : reason === 'timeout' ? 'Repository operation timed out.' : 'Git operation failed. Check the repository and host Git authentication.');
    this.reason = reason;
  }
}

/** Bounded, noninteractive Git; credentials and command diagnostics never enter status or evidence. */
export function repositoryGit(cwd: string, args: string[], signal: AbortSignal, timeoutMs = 30000): Promise<string> {
  signal.throwIfAborted();
  return new Promise((accept, reject) => {
    const detached = process.platform !== 'win32';
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', '-c', 'protocol.ext.allow=never', ...args], {
      cwd, detached, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    const output: Buffer[] = [];
    let bytes = 0, failed = false, expired = false, killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (kind: NodeJS.Signals) => { try { if (detached && child.pid) process.kill(-child.pid, kind); else child.kill(kind); } catch { /* Already exited. */ } };
    const stop = () => { kill('SIGTERM'); killTimer ??= setTimeout(() => kill('SIGKILL'), 1000); killTimer.unref(); };
    const deadline = setTimeout(() => { expired = true; stop(); }, timeoutMs); deadline.unref();
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    const collect = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) { failed = true; stop(); }
      else if (stdout) output.push(chunk);
    };
    child.stdout.on('data', chunk => collect(chunk, true)); child.stderr.on('data', chunk => collect(chunk, false));
    child.once('error', () => { failed = true; });
    child.once('close', code => {
      clearTimeout(deadline); if (killTimer) clearTimeout(killTimer); signal.removeEventListener('abort', stop); kill('SIGKILL');
      if (signal.aborted || expired || failed || code !== 0) reject(new RepositoryGitError(signal.aborted ? 'cancelled' : expired ? 'timeout' : 'failed'));
      else accept(Buffer.concat(output).toString('utf8'));
    });
  });
}

export interface RepositoryRoot { path: string; commonDirectory: string; }
export interface RepositoryWorktree {
  repositoryId: string;
  repository: string;
  path: string;
  baseCommit: string;
  reused: boolean;
}
export async function repositoryRoot(path: string, signal: AbortSignal, timeoutMs = 30000): Promise<RepositoryRoot> {
  const root = await realpath(path);
  if (!(await lstat(root)).isDirectory()) throw Error('Repository path must be a directory.');
  const top = (await repositoryGit(root, ['rev-parse', '--show-toplevel'], signal, timeoutMs)).trim();
  if (await realpath(top) !== root) throw Error('Assign the Git repository root, not a subdirectory.');
  const commonDirectory = await realpath((await repositoryGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal, timeoutMs)).trim());
  return { path: root, commonDirectory };
}

async function directory(parent: string, name: string) {
  const path = join(parent, name);
  await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw Error('Repository worktree storage must contain ordinary directories.');
  return path;
}

async function excludeWorktrees(root: RepositoryRoot, signal: AbortSignal, timeoutMs: number) {
  if ((await repositoryGit(root.path, ['ls-files', '-z', '--', '.werk/worktrees'], signal, timeoutMs)).length) throw Error('Managed worktree storage must not contain tracked files.');
  const info = await directory(root.commonDirectory, 'info');
  const handle = await open(join(info, 'exclude'), constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    if (!(await handle.stat()).isFile()) throw Error('Git exclude must be a regular file.');
    const content = await handle.readFile('utf8');
    if (!content.split(/\r?\n/).includes('/.werk/worktrees/')) await handle.writeFile(`${content.endsWith('\n') || !content ? '' : '\n'}/.werk/worktrees/\n`);
  } finally { await handle.close(); }
}

interface Ownership { version: 1; repositoryId?: string; repository: string; taskKey: string; path: string; baseCommit: string; }
const commitId = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
async function ownedWorktree(path: string, owner: Ownership, root: RepositoryRoot, signal: AbortSignal, timeoutMs: number) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw Error('Existing task worktree identity changed.');
  const dotGit = await lstat(join(path, '.git'));
  if (!dotGit.isFile() || dotGit.isSymbolicLink()) throw Error('Existing task worktree metadata changed.');
  const listing = await repositoryGit(root.path, ['worktree', 'list', '--porcelain', '-z'], signal, timeoutMs);
  // Git for Windows emits forward slashes even when Node's canonical path uses backslashes.
  const registered = listing.split('\0').some(entry => entry.startsWith('worktree ') && isAbsolute(entry.slice(9)) && resolve(entry.slice(9)) === path);
  if (!registered) throw Error('Existing task worktree is not registered with its repository.');
  const observed = await repositoryRoot(path, signal, timeoutMs);
  if (observed.commonDirectory !== root.commonDirectory) throw Error('Existing task worktree belongs to another repository.');
  const head = (await repositoryGit(path, ['rev-parse', '--verify', 'HEAD'], signal, timeoutMs)).trim();
  const branch = (await repositoryGit(path, ['rev-parse', '--abbrev-ref', 'HEAD'], signal, timeoutMs)).trim();
  if (head !== owner.baseCommit || branch !== 'HEAD') throw Error('Existing task worktree base changed; retained work requires review.');
}

/** Retain owned worktrees, including interrupted edits, and never reset or overwrite an existing path. */
export async function createRepositoryWorktree(root: RepositoryRoot, repositoryId: string, taskKey: string, signal: AbortSignal, baseCommit?: string, timeoutMs = 30000): Promise<RepositoryWorktree> {
  signal.throwIfAborted();
  if (!taskKey || taskKey.length > 1024 || !/^[a-zA-Z0-9_-]{1,100}$/.test(repositoryId)) throw Error('Invalid repository task identity.');
  if (baseCommit !== undefined && !commitId(baseCommit)) throw Error('Task base must be a full Git commit identifier.');
  // Bound both checkout and Git administration paths on Windows without losing the full assignment identity.
  // Keep existing short-ID paths stable; long IDs share only a readable prefix, never the identity digest.
  const identity = repositoryId.length > 24 ? JSON.stringify([repositoryId, taskKey]) : taskKey;
  const separator = repositoryId.length > 24 ? '--' : '-';
  const name = `${repositoryId.slice(0, 24)}${separator}${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
  const werk = await directory(root.path, '.werk'), worktrees = await directory(werk, 'worktrees');
  await excludeWorktrees(root, signal, timeoutMs);
  const metadata = await directory(root.commonDirectory, 'werk-worktrees'), path = join(worktrees, name), marker = join(metadata, `${name}.json`);
  let owner: Ownership | undefined;
  const markerInfo = await lstat(marker).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (markerInfo) {
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 16384) throw Error('Task worktree ownership metadata is invalid.');
    try { owner = JSON.parse(await readFile(marker, 'utf8')); } catch { throw Error('Task worktree ownership metadata is invalid.'); }
    if (!owner || owner.version !== 1 || (owner.repositoryId !== repositoryId && !(owner.repositoryId === undefined && repositoryId.length <= 24)) || owner.taskKey !== taskKey || owner.repository !== root.path || owner.path !== path || !commitId(owner.baseCommit) || (baseCommit && owner.baseCommit !== baseCommit)) throw Error('Task worktree ownership does not match this task.');
  }
  const exists = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (exists) {
    if (!owner) throw Error('Task worktree already exists without ownership metadata.');
    await ownedWorktree(path, owner, root, signal, timeoutMs);
    return { repositoryId, repository: root.path, path, baseCommit: owner.baseCommit, reused: true };
  }
  if (!owner) {
    const commit = (await repositoryGit(root.path, ['rev-parse', '--verify', `${baseCommit ?? 'HEAD'}^{commit}`], signal, timeoutMs)).trim();
    if (!commitId(commit)) throw Error('Repository base commit is invalid.');
    owner = { version: 1, repositoryId, repository: root.path, taskKey, path, baseCommit: commit };
    await writeFile(marker, JSON.stringify(owner) + '\n', { flag: 'wx', mode: 0o600 });
  }
  signal.throwIfAborted();
  await repositoryGit(root.path, ['worktree', 'add', '--detach', '--', path, owner.baseCommit], signal, timeoutMs);
  await ownedWorktree(path, owner, root, signal, timeoutMs);
  return { repositoryId, repository: root.path, path, baseCommit: owner.baseCommit, reused: false };
}

/** Backwards-compatible local Git admission; assignment watchers are deliberately separate. */
export async function prepareRepositoryWorktree(repository: string, taskKey: string, signal: AbortSignal, baseCommit?: string): Promise<RepositoryWorktree> {
  return createRepositoryWorktree(await repositoryRoot(resolve(repository), signal), 'local', taskKey, signal, baseCommit);
}
