import { resolve } from 'node:path';
import { DomainError } from '../../shared/errors.js';
import { validateRepositoryConfiguration,                                                         } from '../application/repositories.js';
import { createRepositoryWorktree, removeRepositoryWorktree, repositoryGit, RepositoryGitError, repositoryRoot, retainedWorktrees, worktreeName, WorktreeProblem,                                                                                                                } from './repositories-git.js';

export { prepareRepositoryWorktree, RepositoryGitError, WorktreeProblem } from './repositories-git.js';
                                                                                                                     
/** Checkout and removal of a large tree may outlast metadata commands; callers still bound the whole operation. */
export const WORKTREE_CHECKOUT_TIMEOUT_MS = 300000;
                                                                                                                    
                                                                
                         
                             
                               
                      
                       
                        
                               
                              
                       
 
class RepositoryProblem extends Error {}

/** Serial Git mutations per assignment; independent repositories cannot starve or stop each other. */
export class RepositoryManager {
          config                         ;
          statuses = new Map                          ();
          roots = new Map                        ();
          operations = new Map                          ();
          shutdown = new AbortController();
          timer                                ;
          running = false;
          closed = false;
                   timeoutMs        ;
                   beforeRepositoryUse                                                      ;
                   preserveCheckout                                                ;

  constructor(config                         , options                                                                                                                                                                             = {}) {
    this.config = validateRepositoryConfiguration(config, path => resolve(path));
    this.timeoutMs = options.commandTimeoutMs ?? 30000;
    this.beforeRepositoryUse = options.beforeRepositoryUse;
    this.preserveCheckout = options.preserveCheckout;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300000) throw new DomainError('invalid_input', 'Invalid Git command timeout.');
    this.resetStatuses();
  }
          resetStatuses() {
    this.roots.clear(); this.statuses.clear();
    for (const item of this.config.items) this.statuses.set(item.id, { ...item, state: 'pending', checkoutPreserved: false, currentBranch: null, head: null, ahead: null, behind: null, lastCheckedAt: null, lastPulledAt: null, error: null });
  }
  async configure(config                         ) {
    this.ensureOpen();
    const next = validateRepositoryConfiguration(config, path => resolve(path));
    if (JSON.stringify(next) === JSON.stringify(this.config)) return;
    const restart = this.running; this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await Promise.allSettled([...this.operations.values()]);
    this.ensureOpen(); this.config = next; this.resetStatuses();
    if (restart) { await this.init(); this.start(); }
  }
  async init() { this.ensureOpen(); await this.sync(); }
  view()                     { return [...this.statuses.values()].map(item => ({ ...item, checkoutPreserved: !!this.preserveCheckout?.(item) })); }
  resolve(selector        )                       {
    const item = this.config.items.find(item => item.id === selector || item.path === resolve(selector) || this.roots.get(item.id)?.path === resolve(selector));
    if (!item) throw new DomainError('invalid_input', 'Choose a repository assigned to this worker.');
    return { ...item };
  }
  start() {
    this.ensureOpen(); if (this.running) return; this.running = true; this.schedule();
  }
          schedule() {
    if (!this.running || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll().finally(() => this.schedule());
    }, this.config.pollMs);
    this.timer.unref();
  }
          async poll() {
    await Promise.allSettled(this.config.items.filter(item => item.watch).map(item => this.sync(item.id)));
  }
  async sync(id         , signal              )                              {
    this.ensureOpen();
    const selected = id === undefined ? this.config.items : [this.resolve(id)];
    const bounded = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
    await Promise.allSettled(selected.map(item => this.enqueue(item.id, () => this.syncOne(item, bounded))));
    if (signal?.aborted) signal.throwIfAborted();
    return this.view();
  }
  async prepareWorktree(selector        , taskKey        , signal             , baseCommit         )                              {
    this.ensureOpen(); const item = this.resolve(selector), bounded = AbortSignal.any([signal, this.shutdown.signal]);
    return this.enqueue(item.id, async () => {
      bounded.throwIfAborted();
      const pinnedShared = !!baseCommit && !!this.preserveCheckout?.(item);
      // Shared intake has already fetched and frozen this commit. The developer's
      // branch, staging area and connectivity are unrelated to its task workspace.
      if (!pinnedShared) await this.syncOne(item, bounded);
      bounded.throwIfAborted();
      // A network failure leaves an inspectable status; local committed work remains available offline.
      const root = await this.inspectRoot(item, bounded);
      if (!pinnedShared && item.branch && (await repositoryGit(root.path, ['branch', '--show-current'], bounded, this.timeoutMs)).trim() !== item.branch) throw new DomainError('conflict', 'Check out the assigned branch before starting a task.');
      return createRepositoryWorktree(root, item.id, taskKey, bounded, baseCommit, this.timeoutMs, this.worktreeOptions());
    }, bounded);
  }
  /** Re-verify a retained task worktree without fetching or creating anything. */
  async verifyWorktree(selector        , taskKey        , signal             , baseCommit         )                              {
    this.ensureOpen(); const item = this.resolve(selector), bounded = AbortSignal.any([signal, this.shutdown.signal]);
    return this.enqueue(item.id, async () => {
      const root = await this.inspectRoot(item, bounded);
      return createRepositoryWorktree(root, item.id, taskKey, bounded, baseCommit, this.timeoutMs, { ...this.worktreeOptions(), reuseOnly: true });
    }, bounded);
  }
  /** Ownership records of every assigned repository; one unavailable repository does not hide the others. */
  async worktrees(signal             )                                                                                          {
    this.ensureOpen(); const bounded = AbortSignal.any([signal, this.shutdown.signal]);
    return Promise.all(this.config.items.map(item => this.enqueue(item.id, async () => {
      try { return { repositoryId: item.id, worktrees: await retainedWorktrees(await this.inspectRoot(item, bounded), bounded, this.timeoutMs) }; }
      catch (error) { return { repositoryId: item.id, worktrees: [], error: error instanceof RepositoryGitError || error instanceof WorktreeProblem || error instanceof RepositoryProblem ? error.message : 'Repository unavailable or invalid. Check its local path and Git configuration.' }; }
    }, bounded)));
  }
  /** Remove one owned worktree, identified by name or by the task key that created it. */
  async removeWorktree(selector        , target                                     , signal             , options                 = {})                           {
    this.ensureOpen(); const item = this.resolve(selector), bounded = AbortSignal.any([signal, this.shutdown.signal]);
    const name = target.name ?? worktreeName(item.id, target.taskKey ?? '');
    return this.enqueue(item.id, async () => removeRepositoryWorktree(await this.inspectRoot(item, bounded), name, bounded, this.timeoutMs, { checkoutTimeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS, ...options }), bounded);
  }
          worktreeOptions() {
    return { checkoutTimeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS, ...(this.config.worktreeDirectory ? { directory: this.config.worktreeDirectory, excludedDirectories: [...this.config.items.map(item => item.path), ...[...this.roots.values()].flatMap(root => [root.path, root.commonDirectory])] } : {}) };
  }
  async close() {
    if (!this.closed) { this.closed = true; this.running = false; if (this.timer) clearTimeout(this.timer); this.shutdown.abort(); }
    await Promise.allSettled([...this.operations.values()]);
  }
          ensureOpen() { if (this.closed) throw new DomainError('unavailable', 'Repository watcher is stopped.'); }
          enqueue   (id        , action                  , signal              )             {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => { signal?.throwIfAborted(); return action(); });
    this.operations.set(id, operation);
    const clear = () => { if (this.operations.get(id) === operation) this.operations.delete(id); };
    void operation.then(clear, clear);
    if (!signal) return operation;
    // A caller's deadline also covers waiting behind another operation of this repository.
    // The queued operation stays in order and fails fast when it starts.
    return new Promise   ((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) { void operation.catch(() => {}); abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    });
  }
          async inspectRoot(item                      , signal             ) {
    await this.beforeRepositoryUse?.(item);
    const root = await repositoryRoot(item.path, signal, this.timeoutMs);
    for (const [id, other] of this.roots) if (id !== item.id && other.commonDirectory === root.commonDirectory) throw new RepositoryProblem('The same Git repository cannot have multiple assignments.');
    this.roots.set(item.id, root); return root;
  }
          async syncOne(item                      , signal             ) {
    const status = this.statuses.get(item.id) ;
    status.state = 'syncing'; status.error = null; status.ahead = null; status.behind = null;
    try {
      signal.throwIfAborted();
      const root = await this.inspectRoot(item, signal), preserve = !!this.preserveCheckout?.(item);
      const git = (args          ) => repositoryGit(root.path, [...(preserve ? ['--no-optional-locks'] : []), ...args], signal, this.timeoutMs);
      status.head = (await git(['rev-parse', '--verify', 'HEAD'])).trim();
      const branch = (await git(['branch', '--show-current'])).trim(); status.currentBranch = branch || null;
      if (!branch && (!preserve || !item.branch)) throw new RepositoryProblem('The base checkout is detached. Check out the assigned branch before synchronization.');
      if (!preserve && item.branch && item.branch !== branch) throw new RepositoryProblem('The base checkout is on a different branch than its assignment.');
      const remotes = (await git(['remote'])).trim().split('\n');
      if (!remotes.includes(item.remote)) throw new RepositoryProblem('The assigned Git remote does not exist. Local committed work remains available.');
      await git(['fetch', '--no-recurse-submodules', '--no-tags', '--', item.remote, `refs/heads/${item.branch ?? branch}`]);
      const remoteHead = (await git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
      const storage = (await git(['ls-tree', '-z', remoteHead, '--', '.werk', '.werk/worktrees'])).split('\0').filter(Boolean);
      if (storage.some(entry => entry.split('\t')[1] === '.werk/worktrees' || (entry.split('\t')[1] === '.werk' && !entry.startsWith('040000 ')))) throw new RepositoryProblem('The remote commit would replace managed worktree storage. Review the remote change before synchronizing.');
      const counts = (await git(['rev-list', '--left-right', '--count', `HEAD...${remoteHead}`])).trim().split(/\s+/).map(Number);
      if (counts.length !== 2 || counts.some(value => !Number.isSafeInteger(value) || value < 0)) throw new RepositoryProblem('Git divergence could not be determined.');
      [status.ahead, status.behind] = counts;
      // Exclude only untracked managed worktrees. Tracked files under that directory still count as dirty.
      const dirty = (await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).length > 0;
      if (dirty) { status.state = 'dirty'; return; }
      if (status.ahead && status.behind) { status.state = 'diverged'; return; }
      if (status.ahead) { status.state = 'ahead'; return; }
      if (status.behind) {
        // Enabling shared ownership while a fetch is in flight must also prevent
        // the final merge. Disabling it does not change this operation's promise.
        if (preserve || this.preserveCheckout?.(item)) { status.state = 'behind'; return; }
        await git(['merge', '--ff-only', '--no-edit', '--no-stat', '--no-autostash', remoteHead]);
        status.head = (await git(['rev-parse', '--verify', 'HEAD'])).trim();
        status.behind = 0; status.lastPulledAt = new Date().toISOString();
      }
      status.state = 'ready';
    } catch (error) {
      status.state = 'error';
      status.error = error instanceof RepositoryGitError || error instanceof RepositoryProblem ? error.message : signal.aborted ? 'Repository operation cancelled.' : 'Repository unavailable or invalid. Check its local path and Git configuration.';
    } finally { status.lastCheckedAt = new Date().toISOString(); }
  }
}
