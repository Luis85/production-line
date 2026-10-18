import { gitExecutable } from '../../shared/git/executable.js';
import { gitLaunchMode } from '../../shared/git/launch-mode.js';
import { gitEnvironment } from '../../shared/git/environment.js';
import { ProcessRunError, runProcess } from '../../shared/process/launcher.js';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export class RepositoryGitError extends Error {
  readonly reason: 'failed' | 'timeout' | 'cancelled';
  constructor(reason: 'failed' | 'timeout' | 'cancelled') {
    super(reason === 'cancelled' ? 'Repository operation cancelled.' : reason === 'timeout' ? 'Repository operation timed out.' : 'Git operation failed. Check the repository and host Git authentication.');
    this.reason = reason;
  }
}
/** Fixed worktree policy failures. Messages never contain paths or Git output, so adapters may show them. */
export class WorktreeProblem extends Error {
  constructor(message: string) { super(message); this.name = 'WorktreeProblem'; }
}

/** Bounded, noninteractive Git; credentials and command diagnostics never enter status or evidence. */
export async function repositoryGit(cwd: string, args: string[], signal: AbortSignal, timeoutMs = 30000): Promise<string> {
  signal.throwIfAborted();
  try {
    const mode = gitLaunchMode(args), env = gitEnvironment(mode === 'plain' ? 'host-local' : 'host');
    const result = await runProcess(await gitExecutable(cwd, env, mode), ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'core.longpaths=true', '-c', 'submodule.recurse=false', '-c', 'protocol.ext.allow=never', ...args], {
      cwd, env, mode, observation: { kind: 'git', label: 'Git operation' }, signal, timeoutMs, maxOutputBytes: 2 * 1024 * 1024,
    });
    return result.stdout.toString('utf8');
  } catch (error) {
    const reason = error instanceof ProcessRunError ? error.reason : 'spawn';
    throw new RepositoryGitError(signal.aborted || reason === 'cancelled' ? 'cancelled' : reason === 'timeout' ? 'timeout' : 'failed');
  }
}

export interface RepositoryRoot { path: string; commonDirectory: string; }
export interface RepositoryWorktree {
  repositoryId: string;
  repository: string;
  path: string;
  baseCommit: string;
  reused: boolean;
  pristine?: boolean;
}
export interface WorktreeOptions {
  /** Absolute operator-selected parent for new task worktrees. Default: `<repository>/.werk/worktrees`. */
  directory?: string;
  /** Other assigned checkouts and known Git metadata are excluded from external storage. */
  excludedDirectories?: string[];
  /** Checkout time grows with the tree; this bounds only `worktree add`/`remove`, within the caller's signal. */
  checkoutTimeoutMs?: number;
  /** Verify an existing owned worktree; never create one. */
  reuseOnly?: boolean;
}
export async function repositoryRoot(path: string, signal: AbortSignal, timeoutMs = 30000): Promise<RepositoryRoot> {
  const root = await realpath(path);
  if (!(await lstat(root)).isDirectory()) throw new WorktreeProblem('Repository path must be a directory.');
  const top = (await repositoryGit(root, ['rev-parse', '--show-toplevel'], signal, timeoutMs)).trim();
  if (await realpath(top) !== root) throw new WorktreeProblem('Assign the Git repository root, not a subdirectory.');
  const commonDirectory = await realpath((await repositoryGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal, timeoutMs)).trim());
  return { path: root, commonDirectory };
}

/** Git passes this argument to a child's GIT_DIR, whose Windows byte limit is stricter than filesystem paths. */
export function repositoryWorktreeArgument(repository: string, worktree: string, paths = { relative, isAbsolute }): string {
  const candidate = paths.relative(repository, worktree);
  return !paths.isAbsolute(candidate) && Buffer.byteLength(candidate) < Buffer.byteLength(worktree) ? candidate : worktree;
}

async function directory(parent: string, name: string) {
  const path = join(parent, name);
  await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new WorktreeProblem('Repository worktree storage must contain ordinary directories.');
  return path;
}

async function excludeWorktrees(root: RepositoryRoot, signal: AbortSignal, timeoutMs: number) {
  if ((await repositoryGit(root.path, ['ls-files', '-z', '--', '.werk/worktrees'], signal, timeoutMs)).length) throw new WorktreeProblem('Managed worktree storage must not contain tracked files.');
  const info = await directory(root.commonDirectory, 'info');
  const handle = await open(join(info, 'exclude'), constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    if (!(await handle.stat()).isFile()) throw new WorktreeProblem('Git exclude must be a regular file.');
    const content = await handle.readFile('utf8');
    if (!content.split(/\r?\n/).includes('/.werk/worktrees/')) await handle.writeFile(`${content.endsWith('\n') || !content ? '' : '\n'}/.werk/worktrees/\n`);
  } finally { await handle.close(); }
}

/** Resolve existing ancestors too, so an unavailable checkout cannot hide a parent-directory alias. */
async function canonicalLocation(value: string): Promise<string> {
  let current = resolve(value); const suffix: string[] = [];
  for (;;) {
    try { return join(await realpath(current), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(current) === current) throw new WorktreeProblem('Assigned repository storage could not be verified.');
      suffix.unshift(basename(current)); current = dirname(current);
    }
  }
}
/** Validate all locations before creating storage; task copies must stay outside every assigned checkout. */
async function configuredStorage(root: RepositoryRoot, configured: string, excludedDirectories: string[] = []) {
  const target = resolve(configured), name = basename(target);
  if (!isAbsolute(configured) || !name) throw new WorktreeProblem('The task worktree directory must be an absolute folder path.');
  const parent = await realpath(dirname(target)).catch(() => { throw new WorktreeProblem('The parent folder of the task worktree directory must exist.'); });
  const storage = join(parent, name);
  for (const source of new Set([root.path, root.commonDirectory, ...excludedDirectories])) {
    const base = await canonicalLocation(source), path = relative(base, storage);
    if (path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)))
      throw new WorktreeProblem('Place the task worktree directory outside the repository checkout.');
  }
  return directory(parent, name);
}

interface Ownership { version: 1; repositoryId?: string; repository: string; taskKey: string; path: string; baseCommit: string; }
const commitId = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const managedName = (value: string) => /^[A-Za-z0-9_-]{1,24}-{1,2}[a-f0-9]{32}$/.test(value);
/** Bound both checkout and Git administration paths on Windows without losing the full assignment identity. */
export function worktreeName(repositoryId: string, taskKey: string) {
  // Keep existing short-ID paths stable; long IDs share only a readable prefix, never the identity digest.
  const identity = repositoryId.length > 24 ? JSON.stringify([repositoryId, taskKey]) : taskKey;
  return `${repositoryId.slice(0, 24)}${repositoryId.length > 24 ? '--' : '-'}${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}
async function readOwnership(marker: string): Promise<Ownership | undefined> {
  const info = await lstat(marker).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw new WorktreeProblem('Task worktree ownership metadata is invalid.');
  let owner: Ownership;
  try { owner = JSON.parse(await readFile(marker, 'utf8')); } catch { throw new WorktreeProblem('Task worktree ownership metadata is invalid.'); }
  if (!owner || owner.version !== 1 || typeof owner.taskKey !== 'string' || typeof owner.repository !== 'string' || typeof owner.path !== 'string' || !commitId(owner.baseCommit)) throw new WorktreeProblem('Task worktree ownership metadata is invalid.');
  return owner;
}
/** A retained worktree stays at its recorded location, which must still be a normalized path with its managed name. */
const recordedLocation = (path: string, name: string) => isAbsolute(path) && resolve(path) === path && basename(path) === name;

interface ListedWorktree { path: string; locked?: string; }
async function worktreeListing(root: RepositoryRoot, signal: AbortSignal, timeoutMs: number): Promise<ListedWorktree[]> {
  const listing = await repositoryGit(root.path, ['worktree', 'list', '--porcelain', '-z'], signal, timeoutMs), result: ListedWorktree[] = [];
  let current: ListedWorktree | undefined;
  for (const entry of listing.split('\0')) {
    // Git for Windows emits forward slashes even when Node's canonical path uses backslashes.
    if (entry.startsWith('worktree ')) { current = isAbsolute(entry.slice(9)) ? { path: resolve(entry.slice(9)) } : undefined; if (current) result.push(current); }
    else if (!entry) current = undefined;
    else if (current && (entry === 'locked' || entry.startsWith('locked '))) current.locked = entry.slice(7);
  }
  return result;
}
async function ownedWorktree(path: string, owner: Ownership, root: RepositoryRoot, signal: AbortSignal, timeoutMs: number, listing?: ListedWorktree[]) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new WorktreeProblem('Existing task worktree identity changed.');
  const dotGit = await lstat(join(path, '.git'));
  if (!dotGit.isFile() || dotGit.isSymbolicLink()) throw new WorktreeProblem('Existing task worktree metadata changed.');
  const registered = (listing ?? await worktreeListing(root, signal, timeoutMs)).some(entry => entry.path === path);
  if (!registered) throw new WorktreeProblem('Existing task worktree is not registered with its repository.');
  const observed = await repositoryRoot(path, signal, timeoutMs);
  if (observed.commonDirectory !== root.commonDirectory) throw new WorktreeProblem('Existing task worktree belongs to another repository.');
  const head = (await repositoryGit(path, ['rev-parse', '--verify', 'HEAD'], signal, timeoutMs)).trim();
  const branch = (await repositoryGit(path, ['rev-parse', '--abbrev-ref', 'HEAD'], signal, timeoutMs)).trim();
  if (head !== owner.baseCommit || branch !== 'HEAD') throw new WorktreeProblem('Existing task worktree base changed; retained work requires review.');
}
// Parallel checkout writes independent files concurrently; on Windows NTFS this
// measured about 2.5x faster for a 12,000-file tree. Git before 2.32 ignores it.
// Git child processes of a worktree receive its absolute administration directory
// as GIT_DIR, which Git for Windows rejects above 220 bytes (PATH_MAX - 40).
const childGitDirTooLong = (root: RepositoryRoot, name: string) =>
  process.platform === 'win32' && Buffer.byteLength(join(root.commonDirectory, 'worktrees', name)) > 216;
// Parallel checkout uses such children, so long paths check out serially.
const checkoutWorkers = (root: RepositoryRoot, name: string) =>
  childGitDirTooLong(root, name) ? 1 : Math.min(8, Math.max(1, availableParallelism()));

/** Retain owned worktrees, including interrupted edits, and never reset or overwrite an existing path. */
export async function createRepositoryWorktree(root: RepositoryRoot, repositoryId: string, taskKey: string, signal: AbortSignal, baseCommit?: string, timeoutMs = 30000, options: WorktreeOptions = {}): Promise<RepositoryWorktree> {
  signal.throwIfAborted();
  if (!taskKey || taskKey.length > 1024 || !/^[a-zA-Z0-9_-]{1,100}$/.test(repositoryId)) throw new WorktreeProblem('Invalid repository task identity.');
  if (baseCommit !== undefined && !commitId(baseCommit)) throw new WorktreeProblem('Task base must be a full Git commit identifier.');
  const name = worktreeName(repositoryId, taskKey);
  const metadata = join(root.commonDirectory, 'werk-worktrees'), marker = join(metadata, `${name}.json`);
  const metadataInfo = await lstat(metadata).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (metadataInfo && (!metadataInfo.isDirectory() || metadataInfo.isSymbolicLink() || await realpath(metadata) !== metadata)) throw new WorktreeProblem('Task worktree ownership storage is invalid.');
  const inRepository = join(root.path, '.werk', 'worktrees', name);
  let owner = await readOwnership(marker);
  if (owner && ((owner.repositoryId !== repositoryId && !(owner.repositoryId === undefined && repositoryId.length <= 24)) || owner.taskKey !== taskKey || owner.repository !== root.path || !recordedLocation(owner.path, name) || (baseCommit && owner.baseCommit !== baseCommit))) throw new WorktreeProblem('Task worktree ownership does not match this task.');
  // Retained ownership takes precedence over new storage settings, even if their parent is unavailable.
  if (owner && await lstat(owner.path).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; })) {
    const path = owner.path;
    await ownedWorktree(path, owner, root, signal, timeoutMs);
    // Include ignored and untracked files: either can change approved snapshots.
    // Refuse index flags that could hide changes from Git's worktree comparison.
    const index = await repositoryGit(path, ['ls-files', '-v', '-z'], signal, timeoutMs);
    const ordinaryIndex = index.split('\0').filter(Boolean).every(entry => entry.startsWith('H '));
    const pristine = ordinaryIndex && !(await repositoryGit(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored'], signal, timeoutMs)).length;
    return { repositoryId, repository: root.path, path, baseCommit: owner.baseCommit, reused: true, pristine };
  }
  if (options.reuseOnly) throw new WorktreeProblem('The retained task worktree is missing.');
  const configured = options.directory === undefined ? undefined : join(await configuredStorage(root, options.directory, options.excludedDirectories), name);
  const path = owner?.path ?? configured ?? inRepository;
  if (path !== inRepository && path !== configured) throw new WorktreeProblem('The retained task worktree is missing from its recorded location. Prune it before submitting this task again.');
  const argument = repositoryWorktreeArgument(root.path, path);
  if (process.platform === 'win32' && (join(path, '.git').length >= 260 || Buffer.byteLength(join(argument, '.git')) > 220)) throw new WorktreeProblem(path === inRepository ? 'Use a shorter repository path for task worktrees on Windows.' : 'Use a shorter task worktree directory on Windows.');
  if (await lstat(path).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; })) throw new WorktreeProblem('Task worktree already exists without ownership metadata.');
  if (path === inRepository) {
    await directory(await directory(root.path, '.werk'), 'worktrees');
    await excludeWorktrees(root, signal, timeoutMs);
  }
  await directory(root.commonDirectory, 'werk-worktrees');
  if (!owner) {
    const commit = (await repositoryGit(root.path, ['rev-parse', '--verify', `${baseCommit ?? 'HEAD'}^{commit}`], signal, timeoutMs)).trim();
    if (!commitId(commit)) throw new WorktreeProblem('Repository base commit is invalid.');
    owner = { version: 1, repositoryId, repository: root.path, taskKey, path, baseCommit: commit };
    await writeFile(marker, JSON.stringify(owner) + '\n', { flag: 'wx', mode: 0o600 });
  }
  signal.throwIfAborted();
  await repositoryGit(root.path, ['-c', `checkout.workers=${checkoutWorkers(root, name)}`, 'worktree', 'add', '--detach', '--', argument, owner.baseCommit], signal, Math.max(timeoutMs, options.checkoutTimeoutMs ?? timeoutMs));
  await ownedWorktree(path, owner, root, signal, timeoutMs);
  return { repositoryId, repository: root.path, path, baseCommit: owner.baseCommit, reused: false };
}

/** Backwards-compatible local Git admission; assignment watchers are deliberately separate. */
export async function prepareRepositoryWorktree(repository: string, taskKey: string, signal: AbortSignal, baseCommit?: string, options: WorktreeOptions = {}): Promise<RepositoryWorktree> {
  return createRepositoryWorktree(await repositoryRoot(resolve(repository), signal), 'local', taskKey, signal, baseCommit, 30000, options);
}

export type RetainedWorktreeState = 'present' | 'missing' | 'incomplete' | 'locked' | 'unregistered' | 'invalid';
export interface RetainedWorktree {
  name: string;
  taskKey?: string;
  repositoryId?: string;
  path?: string;
  baseCommit?: string;
  location?: 'repository' | 'external';
  state: RetainedWorktreeState;
}
/** Inspect ownership records without creating storage, reading worktree contents or running checkout-wide Git commands. */
export async function retainedWorktrees(root: RepositoryRoot, signal: AbortSignal, timeoutMs = 30000): Promise<RetainedWorktree[]> {
  const metadata = join(root.commonDirectory, 'werk-worktrees');
  const info = await lstat(metadata).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!info) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) throw new WorktreeProblem('Task worktree ownership storage is invalid.');
  const names = (await readdir(metadata)).filter(file => file.endsWith('.json')).map(file => file.slice(0, -5)).filter(managedName).sort().slice(0, 1000);
  const listing = await worktreeListing(root, signal, timeoutMs), result: RetainedWorktree[] = [];
  for (const name of names) {
    let owner: Ownership | undefined;
    try { owner = await readOwnership(join(metadata, `${name}.json`)); } catch { result.push({ name, state: 'invalid' }); continue; }
    if (!owner || owner.repository !== root.path || !recordedLocation(owner.path, name)) { result.push({ name, state: 'invalid' }); continue; }
    const listed = listing.find(entry => entry.path === owner.path);
    const present = await lstat(owner.path).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; });
    const state: RetainedWorktreeState = !present ? 'missing' : !listed ? 'unregistered' : listed.locked === 'initializing' ? 'incomplete' : listed.locked !== undefined ? 'locked' : 'present';
    result.push({ name, taskKey: owner.taskKey, ...(owner.repositoryId ? { repositoryId: owner.repositoryId } : {}), path: owner.path, baseCommit: owner.baseCommit, location: owner.path === join(root.path, '.werk', 'worktrees', name) ? 'repository' : 'external', state });
  }
  return result;
}

/** Git for Windows follows junctions while deleting a worktree, also for ignored paths and without --force. */
async function linkFree(path: string, limit = 500000) {
  const pending = [path];
  let entries = 0;
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (++entries > limit || entry.isSymbolicLink()) return false;
      if (entry.isFile()) continue;
      const info = await lstat(join(current, entry.name));
      if (info.isSymbolicLink()) return false;
      if (info.isDirectory()) pending.push(join(current, entry.name));
    }
  }
  return true;
}
export interface WorktreeRemoval {
  name: string;
  path?: string;
  outcome: 'removed' | 'would_remove' | 'kept';
  reason?: string;
  changes?: number;
}
export interface RemovalOptions {
  /** Present when deleting a known task: the ownership record must describe exactly this worktree. */
  expect?: { taskKey: string; path: string; baseCommit: string };
  /** The operator confirmed discarding uncommitted/untracked files or an interrupted checkout. */
  discardChanges?: boolean;
  dryRun?: boolean;
  checkoutTimeoutMs?: number;
}
/**
 * Remove one owned task worktree through Git and then its ownership record. Never
 * deletes an unregistered directory, follows links, discards commits made on the
 * detached task HEAD, or overrides an operator's lock.
 */
export async function removeRepositoryWorktree(root: RepositoryRoot, name: string, signal: AbortSignal, timeoutMs = 30000, options: RemovalOptions = {}): Promise<WorktreeRemoval> {
  if (!managedName(name)) throw new WorktreeProblem('Unknown task worktree.');
  const marker = join(root.commonDirectory, 'werk-worktrees', `${name}.json`), owner = await readOwnership(marker);
  if (!owner) throw new WorktreeProblem('This worktree is not managed by the worker.');
  if (owner.repository !== root.path || !recordedLocation(owner.path, name)) throw new WorktreeProblem('Task worktree ownership metadata is invalid.');
  if (options.expect && (owner.taskKey !== options.expect.taskKey || owner.path !== options.expect.path || owner.baseCommit !== options.expect.baseCommit)) throw new WorktreeProblem('Task worktree ownership does not match this task.');
  const path = owner.path, kept = (reason: string, changes?: number): WorktreeRemoval => ({ name, path, outcome: 'kept', reason, ...(changes === undefined ? {} : { changes }) });
  const listing = await worktreeListing(root, signal, timeoutMs), listed = listing.find(entry => entry.path === path);
  const present = await lstat(path).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; });
  const argument = repositoryWorktreeArgument(root.path, path), removeTimeout = Math.max(timeoutMs, options.checkoutTimeoutMs ?? timeoutMs);
  let changes: number | undefined, forced = 0;
  if (present) {
    if (!listed) return kept('The directory is not a registered worktree of this repository; review it manually.');
    try { await ownedWorktree(path, owner, root, signal, timeoutMs, listing); }
    catch (error) {
      if (error instanceof WorktreeProblem && /base changed/.test(error.message)) return kept('The task worktree has commits or a branch that removal would discard; review it manually.');
      throw error;
    }
    if (listed.locked !== undefined && listed.locked !== 'initializing') return kept('The worktree is locked. Unlock it in Git after review.');
    if (!await linkFree(path)) return kept('The worktree contains symbolic links or junctions; review and remove it manually.');
    if (listed.locked === 'initializing') {
      // An interrupted checkout holds Git's own initialization lock and an incomplete tree.
      if (!options.discardChanges) return kept('The worktree checkout was interrupted. Confirm discarding it to remove it.');
      forced = 2;
    } else {
      changes = (await repositoryGit(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal, removeTimeout)).split('\0').filter(Boolean).length;
      if (changes && !options.discardChanges) return kept('The worktree has uncommitted or untracked changes. Confirm discarding them to remove it.', changes);
      // Git's own cleanliness check runs `git status` as such a child; the status
      // above already established that this worktree is clean.
      if (changes || childGitDirTooLong(root, name)) forced = 1;
    }
  } else if (listed?.locked !== undefined) return kept('The missing worktree is locked. Unlock it in Git after review.');
  if (options.dryRun) return { name, path, outcome: 'would_remove', ...(changes === undefined ? {} : { changes }) };
  if (listed) await repositoryGit(root.path, ['worktree', 'remove', ...Array(forced).fill('--force'), '--', argument], signal, removeTimeout);
  if (await lstat(path).then(() => true, () => false)) throw new WorktreeProblem('Git did not remove the task worktree.');
  const info = await lstat(marker);
  if (info.isFile() && !info.isSymbolicLink()) await unlink(marker);
  return { name, path, outcome: 'removed', ...(changes === undefined ? {} : { changes }) };
}
