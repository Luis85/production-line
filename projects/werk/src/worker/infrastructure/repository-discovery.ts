import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { RepositoryAssignment } from '../application/repositories.js';
import { DomainError } from '../../shared/errors.js';
import { atomicWrite, readBoundedFile } from './journal/files.js';

const execute = promisify(execFile);
const validRemote = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.endsWith('.lock') && !name.includes('..');
interface Candidate { id: string; path: string; commonDirectory: string; currentBranch: string | null; remote: string | null; }
interface Decision { version: 1; id: string; decision: 'accepted' | 'declined'; repositoryId?: string; }
export interface RepositoryDiscoveryStatus {
  id: string; path: string; currentBranch: string | null; remote: string | null;
  decision: 'pending' | 'accepted' | 'declined'; repositoryId?: string; watch: boolean;
}

/** Inspection is local and read-only: never discover an ancestor or invoke remote transports. */
async function inspect(path: string, signal: AbortSignal): Promise<Candidate | null> {
  try {
    // Git for Windows has a higher cold-process startup cost; keep the entire probe bounded.
    const timeoutMs = process.platform === "win32" ? 10000 : 2500;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const root = await realpath(path), metadata = await lstat(join(root, '.git'));
    if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) return null;
    // Do not allow ambient GIT_DIR/GIT_WORK_TREE/config injection to redirect this inspection.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    const git = async (...args: string[]) => (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: root, env: { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', maxBuffer: 65536, timeout: Math.min(timeoutMs, 5000), windowsHide: true, signal: bounded })).stdout.trim();
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
  private candidate: Candidate | null = null;
  private decision?: Decision;
  private assignedId?: string;
  private approvedLegacy = false;
  private legacyInstallation = false;
  private directory: string;
  private installation: string;
  private signal: AbortSignal;
  private legacyRepository?: string;
  constructor(directory: string, installation: string, signal: AbortSignal, legacyRepository?: string) {
    this.directory = directory; this.installation = installation; this.signal = signal; this.legacyRepository = legacyRepository;
    this.legacyInstallation = legacyRepository !== undefined && resolve(legacyRepository) === resolve(installation);
  }
  async init(assignments: RepositoryAssignment[]) {
    try {
      const value = JSON.parse(await readBoundedFile(join(this.directory, 'repository-discovery.json'), 1024));
      if (!value || value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.id) || !['accepted', 'declined'].includes(value.decision) || Object.keys(value).some(key => !['version', 'id', 'decision', 'repositoryId'].includes(key))) throw Error('Invalid repository discovery decision.');
      if (value.repositoryId !== undefined && (typeof value.repositoryId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.repositoryId))) throw Error('Invalid repository discovery assignment.');
      this.decision = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await this.assignmentsChanged(assignments);
    if (this.candidate && this.legacyRepository) {
      const approved = await inspect(resolve(this.legacyRepository), this.signal);
      this.legacyInstallation ||= approved?.path === this.candidate.path;
      this.approvedLegacy = approved?.path === this.candidate.path && approved.id === this.candidate.id && (!this.decision || this.decision.id === this.candidate.id && this.decision.decision === 'accepted');
      if (this.approvedLegacy) await this.record('accepted');
    }
  }
  legacyAllowed(): boolean { return !this.legacyInstallation || !this.candidate || this.view()?.decision === "accepted"; }
  view(): RepositoryDiscoveryStatus | null {
    if (!this.candidate) return null;
    const { commonDirectory: _, ...candidate } = this.candidate;
    const decision = this.decision?.id === candidate.id ? this.decision.decision : this.approvedLegacy || (this.assignedId && this.decision?.repositoryId !== this.assignedId) ? 'accepted' : 'pending';
    return { ...candidate, decision, watch: !!candidate.remote && !!candidate.currentBranch, ...(this.assignedId ? { repositoryId: this.assignedId } : {}) };
  }
  async assignmentsChanged(assignments: RepositoryAssignment[]) {
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
  async verify(id: unknown) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new DomainError('invalid_input', 'Choose the detected installation repository.');
    const candidate = await inspect(resolve(this.installation), this.signal);
    const previous = this.candidate?.id;
    this.candidate = candidate;
    if (!candidate || candidate.id !== id || previous !== id) {
      this.assignedId = undefined; this.approvedLegacy = false;
      throw new DomainError('conflict', 'The installation repository changed. Refresh and review it before choosing.');
    }
    return this.view()!;
  }
  assignment(items: RepositoryAssignment[]): RepositoryAssignment {
    if (!this.candidate) throw new DomainError('conflict', 'The installation repository is no longer available.');
    const name = basename(this.candidate.path).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'repository';
    const base = `local-${name}-${this.candidate.id.slice(0, 12)}`;
    let id = base, suffix = 1;
    while (items.some(item => item.id === id)) id = `${base}-${suffix++}`;
    return { id, path: this.candidate.path, remote: this.candidate.remote ?? 'origin', watch: !!this.candidate.remote && !!this.candidate.currentBranch };
  }
  async record(decision: 'accepted' | 'declined', repositoryId = this.assignedId) {
    if (!this.candidate) throw new DomainError('conflict', 'The installation repository is no longer available.');
    const next: Decision = { version: 1, id: this.candidate.id, decision, ...(repositoryId ? { repositoryId } : {}) };
    await atomicWrite(join(this.directory, 'repository-discovery.json'), JSON.stringify(next) + '\n');
    this.decision = next;
  }
  async assertAllowed(path: string) {
    const installation = await realpath(resolve(this.installation)).catch(() => null);
    if (!installation || await realpath(path).catch(() => null) !== installation) return;
    const metadata = await lstat(join(installation, '.git')).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    const candidate = await inspect(installation, this.signal);
    if (metadata && !candidate) throw new DomainError('unavailable', 'The installation repository could not be checked safely. Check its Git metadata and permissions before retrying.');
    if (candidate?.id !== this.candidate?.id) { this.approvedLegacy = false; this.candidate = candidate; }
    if (this.candidate && this.view()?.decision !== 'accepted') throw new DomainError('conflict', 'Approve the detected installation repository in the worker before starting repository tasks.');
  }
}
