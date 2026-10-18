import { gitEnvironment } from '../../shared/git/environment.js';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
                                                                           
import { DomainError } from '../../shared/errors.js';
import { atomicWrite, readBoundedFile } from './journal/files.js';
import { runProcess } from '../../shared/process/launcher.js';

const validRemote = (name        ) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.endsWith('.lock') && !name.includes('..');
                                                                                                                               
                                                                                                        
                                            
                                                                                
                                                                                       
 

/** Inspection is local and read-only: never discover an ancestor or invoke remote transports. */
async function inspect(path        , signal             )                            {
  try {
    // Git for Windows has a higher cold-process startup cost; keep the entire probe bounded.
    const timeoutMs = process.platform === "win32" ? 10000 : 2500;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const root = await realpath(path), metadata = await lstat(join(root, '.git'));
    if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) return null;
    // Do not allow ambient GIT_DIR/GIT_WORK_TREE/config injection to redirect this inspection.
    const env = gitEnvironment('immutable');
    const git = async (...args          ) => (await runProcess('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: root, env: { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_OPTIONAL_LOCKS: '0' }, maxOutputBytes: 65536, timeoutMs: Math.min(timeoutMs, 5000), graceMs: 0, signal: bounded })).stdout.toString('utf8').trim();
    if (await realpath(await git('rev-parse', '--show-toplevel')) !== root) return null;
    const commonDirectory = await realpath(await git('rev-parse', '--path-format=absolute', '--git-common-dir'));
    const common = await lstat(commonDirectory);
    if (!common.isDirectory() || common.isSymbolicLink()) return null;
    const currentBranch = await git('branch', '--show-current') || null;
    const remotes = (await git('remote')).split(/\r?\n/).filter(validRemote);
    const upstream = currentBranch ? await git('config', '--get', `branch.${currentBranch}.remote`).catch(() => '') : '';
    const remote = remotes.includes(upstream) ? upstream : remotes.includes('origin') ? 'origin' : remotes[0] ?? null;
    // Birth time and inode distinguish a replacement repository at the same path without
    // invalidating approval when commits, branches or configuration change normally.
    const id = createHash('sha256').update(JSON.stringify([root, commonDirectory, common.dev, common.ino, common.birthtimeMs, metadata.dev, metadata.ino, metadata.birthtimeMs])).digest('hex');
    return { id, path: root, commonDirectory, currentBranch, remote };
  } catch (error) { if (signal.aborted) throw error; return null; }
}

/** One installation has one candidate; only the explicit decision is persisted privately. */
export class RepositoryDiscovery {
          candidate                   = null;
          decision           ;
          assignedId         ;
          approvedLegacy = false;
          legacyInstallation = false;
          directory        ;
          installation        ;
          signal             ;
          legacyRepository         ;
  constructor(directory        , installation        , signal             , legacyRepository         ) {
    this.directory = directory; this.installation = installation; this.signal = signal; this.legacyRepository = legacyRepository;
    this.legacyInstallation = legacyRepository !== undefined && resolve(legacyRepository) === resolve(installation);
  }
  async init(assignments                        ) {
    try {
      const value = JSON.parse(await readBoundedFile(join(this.directory, 'repository-discovery.json'), 1024));
      if (!value || value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.id) || !['accepted', 'declined'].includes(value.decision) || Object.keys(value).some(key => !['version', 'id', 'decision', 'repositoryId'].includes(key))) throw Error('Invalid repository discovery decision.');
      if (value.repositoryId !== undefined && (typeof value.repositoryId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.repositoryId))) throw Error('Invalid repository discovery assignment.');
      this.decision = value;
    } catch (error) { if ((error                         ).code !== 'ENOENT') throw error; }
    await this.assignmentsChanged(assignments);
    if (this.candidate && this.legacyRepository) {
      const approved = await inspect(resolve(this.legacyRepository), this.signal);
      this.legacyInstallation ||= approved?.path === this.candidate.path;
      this.approvedLegacy = approved?.path === this.candidate.path && approved.id === this.candidate.id && (!this.decision || this.decision.id === this.candidate.id && this.decision.decision === 'accepted');
      if (this.approvedLegacy) await this.record('accepted');
    }
  }
  legacyAllowed()          { return !this.legacyInstallation || !this.candidate || this.view()?.decision === "accepted"; }
  view()                                   {
    if (!this.candidate) return null;
    const { commonDirectory: _, ...candidate } = this.candidate;
    const decision = this.decision?.id === candidate.id ? this.decision.decision : this.approvedLegacy || (this.assignedId && this.decision?.repositoryId !== this.assignedId) ? 'accepted' : 'pending';
    return { ...candidate, decision, watch: !!candidate.remote && !!candidate.currentBranch, ...(this.assignedId ? { repositoryId: this.assignedId } : {}) };
  }
  async assignmentsChanged(assignments                        ) {
    // Explicit assignment can follow Git initialization after worker startup.
    // Refresh before matching it, while keeping prior choices bound to their identity.
    const candidate = await inspect(resolve(this.installation), this.signal);
    if (candidate?.id !== this.candidate?.id) this.approvedLegacy = false;
    this.candidate = candidate;
    this.assignedId = undefined;
    if (!this.candidate) return;
    for (const assignment of assignments) {
      const path = await realpath(assignment.path).catch(() => null);
      if (path === this.candidate.path) { this.assignedId = assignment.id; break; }
      // Ordinary checkouts expose their common directory directly; do not spawn Git
      // for every unrelated assignment in a worker with a large repository list.
      const metadata = path ? await lstat(join(path, '.git')).catch(() => null) : null;
      if (path && metadata?.isDirectory() && !metadata.isSymbolicLink()) {
        if (await realpath(join(path, '.git')) === this.candidate.commonDirectory) { this.assignedId = assignment.id; break; }
        continue;
      }
      const assigned = path && metadata?.isFile() && !metadata.isSymbolicLink() ? await inspect(path, this.signal) : null;
      if (assigned?.commonDirectory === this.candidate.commonDirectory) { this.assignedId = assignment.id; break; }
    }
    if (this.assignedId && this.decision?.repositoryId !== this.assignedId) await this.record('accepted', this.assignedId);
  }
  async verify(id         ) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new DomainError('invalid_input', 'Choose the detected installation repository.');
    const candidate = await inspect(resolve(this.installation), this.signal);
    const previous = this.candidate?.id;
    this.candidate = candidate;
    if (!candidate || candidate.id !== id || previous !== id) {
      this.assignedId = undefined; this.approvedLegacy = false;
      throw new DomainError('conflict', 'The installation repository changed. Refresh and review it before choosing.');
    }
    return this.view() ;
  }
  assignment(items                        )                       {
    if (!this.candidate) throw new DomainError('conflict', 'The installation repository is no longer available.');
    const name = basename(this.candidate.path).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'repository';
    const base = `local-${name}-${this.candidate.id.slice(0, 12)}`;
    let id = base, suffix = 1;
    while (items.some(item => item.id === id)) id = `${base}-${suffix++}`;
    return { id, path: this.candidate.path, remote: this.candidate.remote ?? 'origin', watch: !!this.candidate.remote && !!this.candidate.currentBranch };
  }
  async record(decision                         , repositoryId = this.assignedId) {
    if (!this.candidate) throw new DomainError('conflict', 'The installation repository is no longer available.');
    const next           = { version: 1, id: this.candidate.id, decision, ...(repositoryId ? { repositoryId } : {}) };
    await atomicWrite(join(this.directory, 'repository-discovery.json'), JSON.stringify(next) + '\n');
    this.decision = next;
  }
  async assertAllowed(path        ) {
    const installation = await realpath(resolve(this.installation)).catch(() => null);
    if (!installation || await realpath(path).catch(() => null) !== installation) return;
    const metadata = await lstat(join(installation, '.git')).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    const candidate = await inspect(installation, this.signal);
    if (metadata && !candidate) throw new DomainError('unavailable', 'The installation repository could not be checked safely. Check its Git metadata and permissions before retrying.');
    if (candidate?.id !== this.candidate?.id) { this.approvedLegacy = false; this.candidate = candidate; }
    if (this.candidate && this.view()?.decision !== 'accepted') throw new DomainError('conflict', 'Approve the detected installation repository in the worker before starting repository tasks.');
  }
}
