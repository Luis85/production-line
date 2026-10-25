import { DomainError } from '../../shared/errors.js';
import { identifier, object, text } from '../../shared/contracts.js';
import { featureWorkflowPath } from './feature-workflow.js';
import { remoteDeliveryBranch } from './remote-delivery-policy.js';
import { gateDigest } from './request-gates.js';

export interface ManagedProjectDefinition {
  id: string; name: string; mode: 'clone' | 'adopt'; repository: string; branch: string;
  featuresDirectory: string; path: string; intake: 'shared' | 'local';
}
export interface ManagedProject extends ManagedProjectDefinition {
  operationId: string; status: 'preparing' | 'ready' | 'needs_attention'; attached: boolean;
  createdAt: string; updatedAt: string; detail: string; head?: string;
  operations: { operationId: string; digest: string; action: string }[];
}
export interface ManagedProjectState { schemaVersion: 1; projects: ManagedProject[]; }
export interface ManagedProjectsView {
  schemaVersion: 1; home: string;
  projects: (Omit<ManagedProject, 'operations'> & { intakeEnabled: boolean; policyApproved?: boolean; intakeBlockedReason?: string | null; workflow: { configured: boolean; templates: { id: string; path: string; label: string }[] } })[];
  diagnostics: { id: 'git' | 'claude' | 'github'; available: boolean; detail: string }[];
}
export interface ManagedProjectPorts {
  load(): Promise<ManagedProjectState>;
  save(state: ManagedProjectState): Promise<void>;
  location(id: string): string;
  adopt(path: string, branch: string, signal: AbortSignal): Promise<{ path: string; repository: string; head: string }>;
  clone(project: ManagedProject, signal: AbortSignal): Promise<void>;
  inspect(project: ManagedProject, signal: AbortSignal): Promise<{ ready: boolean; head?: string }>;
  attach(project: ManagedProject): Promise<void>;
}
type ManagedProjectCommand =
  | { action: 'register'; operationId: string; id: string; name?: string; repository: string; branch?: string; featuresDirectory?: string; intake?: 'shared' | 'local' }
  | { action: 'adopt'; operationId: string; id: string; name?: string; path: string; branch?: string; featuresDirectory?: string; intake?: 'shared' | 'local' }
  | { action: 'reconcile' | 'retry'; operationId: string; id: string };
const invalid = (message: string): never => { throw new DomainError('invalid_input', message); };
const conflict = (message: string): never => { throw new DomainError('conflict', message); };

/** Operator destinations exclude embedded credentials, command transports and ambiguous URL syntax. */
export function managedRepository(value: unknown): string {
  const source = text(value, 'Project repository', 4096);
  if (/[\x00-\x20\x7f]/.test(source) || source.startsWith('-')) invalid('Use a repository URL without whitespace, options or credentials.');
  if (/^git@[a-z0-9.-]+:[A-Za-z0-9_./-]+\.git$/i.test(source) && !source.includes('..')) return source;
  let url: URL;
  try { url = new URL(source); } catch { return invalid('Use an HTTPS, SSH or local file repository URL.'); }
  if (!['https:', 'ssh:', 'file:'].includes(url.protocol) || url.password || url.search || url.hash ||
      url.protocol === 'https:' && url.username || url.protocol === 'ssh:' && url.username !== 'git' ||
      url.protocol === 'file:' && (url.username || url.host && url.host !== 'localhost') ||
      url.protocol !== 'file:' && !url.hostname || !url.pathname || url.pathname === '/')
    invalid('Use an HTTPS, git SSH or local file URL without embedded credentials.');
  return url.toString();
}
function parseManagedProjectCommand(value: unknown): ManagedProjectCommand {
  const raw = object(value, 'Managed project command', ['action', 'operationId', 'id', 'name', 'repository', 'path', 'branch', 'featuresDirectory', 'intake']);
  const id = identifier(raw.id, 'Project ID'), operationId = identifier(raw.operationId, 'Operation ID');
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) invalid('Project IDs must be portable lowercase names of 1–40 characters.');
  if (raw.action === 'reconcile' || raw.action === 'retry') {
    if (['name', 'repository', 'path', 'branch', 'featuresDirectory', 'intake'].some(key => raw[key] !== undefined)) invalid('Recovery uses the saved project definition.');
    return { action: raw.action, operationId, id };
  }
  if (raw.action !== 'register' && raw.action !== 'adopt') invalid('Managed project actions: register, adopt, reconcile or retry.');
  const name = raw.name === undefined ? id : text(raw.name, 'Project name', 120).trim();
  if (!name || /[\x00-\x1f\x7f]/.test(name)) invalid('Give the project a nonempty display name.');
  const branch = remoteDeliveryBranch(raw.branch ?? 'main');
  const featuresDirectory = featureWorkflowPath(raw.featuresDirectory ?? 'features', 'Feature intake directory');
  if (featuresDirectory.toLowerCase().split('/').some(part => ['.werk', '.agents', '.claude', '.codex'].includes(part))) invalid('Feature intake must be outside private worker state.');
  if (raw.intake !== undefined && raw.intake !== 'shared' && raw.intake !== 'local') invalid('Choose shared or local project intake.');
  const intake = raw.intake === 'local' ? 'local' as const : 'shared' as const;
  const common = { operationId, id, name, branch, featuresDirectory, intake };
  if (raw.action === 'register') {
    if (raw.path !== undefined) invalid('Clone destinations are managed by the worker. Use adopt for an existing checkout.');
    return { ...common, action: 'register', repository: managedRepository(raw.repository) };
  }
  if (raw.repository !== undefined) invalid('Adoption reads the existing origin; it never changes repository configuration.');
  const path = text(raw.path, 'Project checkout path', 4096);
  if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path) || /[\x00-\x1f\x7f]/.test(path)) invalid('Adoption requires an absolute checkout path.');
  return { ...common, action: 'adopt', path };
}

/** The saved intent is authoritative across process restarts; callbacks own filesystem and settings adapters. */
export class ManagedProjects {
  private ports: ManagedProjectPorts;
  constructor(ports: ManagedProjectPorts) { this.ports = ports; }
  async command(value: unknown, signal: AbortSignal): Promise<ManagedProject> {
    const input = parseManagedProjectCommand(value), digest = gateDigest(input), state = await this.ports.load();
    let project = state.projects.find(item => item.id === input.id);
    const previous = state.projects.flatMap(item => item.operations).find(item => item.operationId === input.operationId);
    if (previous && previous.digest !== digest) conflict('This operation ID already identifies another immutable project command.');
    if (!previous) {
      if (input.action === 'register' || input.action === 'adopt') {
        if (project) conflict('This project ID is registered already. Reconcile its saved operation instead of replacing its identity.');
        if (state.projects.length >= 64) conflict('This worker already has the maximum 64 managed projects.');
        const adoption = input.action === 'adopt' ? await this.ports.adopt(input.path, input.branch!, signal) : undefined;
        const at = new Date().toISOString();
        project = { id: input.id, name: input.name!, mode: adoption ? 'adopt' : 'clone', repository: adoption?.repository ?? (input as Extract<ManagedProjectCommand, { action: 'register' }>).repository,
          branch: input.branch!, featuresDirectory: input.featuresDirectory!, intake: input.intake ?? 'shared', path: adoption?.path ?? this.ports.location(input.id),
          operationId: input.operationId, status: 'preparing', attached: false, createdAt: at, updatedAt: at, detail: 'Project registration intent is saved.', operations: [] };
        state.projects.push(project);
      } else if (!project) throw new DomainError('not_found', 'Managed project not found.');
      if (!project) throw new DomainError('not_found', 'Managed project not found.');
      if (project.operations.length >= 32) conflict('Project registration reached its bounded operation history. Retain and inspect its records.');
      if (input.action === 'retry') {
        if (project.mode !== 'clone' || project.attached || project.status === 'ready') conflict('Retry applies only to an unattached clone that needs recovery.');
        project.operationId = input.operationId; project.status = 'preparing';
      }
      project.operations.push({ operationId: input.operationId, digest, action: input.action });
      await this.ports.save(state);
    }
    if (!project) throw new DomainError('not_found', 'Managed project not found.');
    try {
      signal.throwIfAborted();
      if (!previous && (input.action === 'register' || input.action === 'retry')) await this.ports.clone(project, signal);
      const observation = await this.ports.inspect(project, signal);
      if (!observation.ready || !observation.head) {
        project.status = 'needs_attention'; project.detail = 'The saved checkout is incomplete or does not match its repository and branch. Reconcile after inspection, or explicitly retry an unattached clone.';
      } else {
        project.head = observation.head; project.status = 'ready';
        await this.ports.attach(project); project.attached = true;
        project.detail = 'Repository registration is confirmed. Review the committed workflow and approve its exact delivery policy, then recheck project setup to enable intake.';
      }
    } catch (error) {
      project.status = 'needs_attention';
      project.detail = error instanceof DomainError ? error.message.slice(0, 1800) : 'Project setup could not be confirmed. Check Git availability, host authentication and the configured branch; reconcile before retrying. Existing checkouts and incomplete clone folders are preserved.';
    }
    project.updatedAt = new Date().toISOString(); await this.ports.save(state);
    return structuredClone(project);
  }
}
