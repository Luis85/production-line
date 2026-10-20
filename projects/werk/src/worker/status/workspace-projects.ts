import type { FeatureRequests } from '../application/feature-requests.js';
import type { SharedFeatureIntake } from '../application/shared-feature-intake.js';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { DomainError } from '../../shared/errors.js';
import { ensureDirectory } from '../infrastructure/journal/files.js';
import type { RepositoryAssignment } from '../application/repositories.js';
import type { FeatureRecord } from '../application/feature-requests.js';
import type { WorkspaceContext } from './workspace-context.js';
import { attachProjectFeatureFolder, createProjectFeatureRuntime, type WorkspaceFeatureProject } from './workspace-project-features.js';

/** Project selection is composition metadata, never another request lifecycle or execution queue. */
export class WorkspaceProjectIntakes {
  private additional = new Map<string, WorkspaceFeatureProject>();
  private running = false;
  private workspace: WorkspaceContext;
  readonly primary: WorkspaceFeatureProject;
  constructor(workspace: WorkspaceContext, primary: WorkspaceFeatureProject) { this.workspace = workspace; this.primary = primary; }
  all() { return [this.primary, ...this.additional.values()]; }
  id(project: WorkspaceFeatureProject): string {
    return project.sharedRuntime.intake.binding?.repositoryId || project.id
      || this.workspace.settings.value.repositories.items.find(item => resolve(item.path) === project.repository)?.id || 'primary';
  }
  repository(project: WorkspaceFeatureProject): string {
    const id = project.sharedRuntime.intake.binding?.repositoryId;
    return id ? this.workspace.repositories.resolve(id).path : project.repository;
  }
  assertSharedBinding(project: WorkspaceFeatureProject, repositoryId: string) {
    const previous = this.additional.get(repositoryId);
    if (project.primary && previous && previous !== project && (previous.features?.view().records.length || previous.sharedRuntime.intake.binding?.repositoryId || previous.sharedRuntime.intake.dependencyInputs().length))
      throw new DomainError('conflict', 'This project already owns retained Feature Requests. Select that project explicitly to configure its shared intake; transferring it to the primary intake would abandon its existing lifecycle.');
  }
  resolve(projectId?: string): WorkspaceFeatureProject {
    if (projectId === undefined || projectId === this.id(this.primary)) return this.primary;
    const found = this.additional.get(projectId);
    if (!found) throw new DomainError('not_found', 'Choose a registered project for this Feature Request.');
    return found;
  }
  choices() { return this.all().map(project => {
    const binding = project.sharedRuntime.intake.binding?.repositoryId;
    const sharedDirectory = project.sharedRuntime.intake.view().workflow?.requestsDirectory;
    const directory = binding ? sharedDirectory ? join(this.repository(project), sharedDirectory) : undefined : project.directory;
    return { id: this.id(project), label: this.id(project), ...(directory ? { directory } : {}), enabled: !!project.features || !!binding,
      ...(!project.features && !binding ? { reason: 'Configure a feature intake folder or shared Git intake for this repository.' } : {}) };
  }); }
  forRecord(record: FeatureRecord) {
    return this.all().find(project => (record.feature?.scope !== undefined && project.features?.view().directory === record.feature.scope)
      || project.features?.view().records.some(item => item.sessionId === record.sessionId)) ?? this.primary;
  }
  forRepository(repository: string) { return this.all().find(project => this.repository(project) === resolve(repository)) ?? this.all().find(project => project.repository === resolve(repository)); }
  forSession(sessionId: string, existingKey?: string) {
    for (const project of this.all()) {
      const features: FeatureRequests | undefined = project.features;
      const reference = features?.referenceForSession(sessionId, existingKey);
      if (reference) return { project, reference };
    }
    return undefined;
  }
  sharedForTask(taskId: string, existingKey?: string) {
    for (const project of this.all()) {
      const intake: SharedFeatureIntake = project.sharedRuntime.intake;
      const reference = intake.referenceForTask(taskId, existingKey);
      if (reference) return { project, reference, source: intake.sourceForTask(taskId) };
    }
    return undefined;
  }
  get busy() { return this.all().some(project => project.sharedRuntime.intake.busy); }
  requiredRepositoryIds() {
    return [...new Set(this.all().flatMap(project => {
      const intake: SharedFeatureIntake = project.sharedRuntime.intake;
      const local = this.workspace.settings.value.repositories.items.find(item => resolve(item.path) === project.repository);
      return [...intake.requiredRepositoryIds(), ...(project.features?.view().records.length && local ? [local.id] : [])];
    }))];
  }
  preservesCheckout(item: RepositoryAssignment) {
    return this.all().some(project => !!project.features && project.repository === resolve(item.path)
      || project.sharedRuntime.intake.binding?.repositoryId === item.id || project.sharedRuntime.intake.requiredRepositoryIds().includes(item.id));
  }
  assertAssignments(items: RepositoryAssignment[]) {
    for (const id of this.requiredRepositoryIds()) {
      const current = this.workspace.settings.value.repositories.items.find(item => item.id === id), next = items.find(item => item.id === id);
      if (!next || next.path !== current?.path || next.features?.directory !== current?.features?.directory)
        throw new DomainError('conflict', 'Keep project repository and intake settings while retained requests or shared publications depend on them.');
    }
  }
  async init() {
    await this.primary.sharedRuntime.intake.init();
    await this.primary.features?.init();
    await this.configure();
  }
  async configure() {
    const primaryAssignment = this.workspace.settings.value.repositories.items.find(item => resolve(item.path) === this.primary.repository);
    const primaryDirectory = primaryAssignment?.features ? join(primaryAssignment.path, primaryAssignment.features.directory) : this.workspace.config.features?.directory;
    const primaryPollMs = primaryAssignment?.features?.pollMs ?? this.workspace.config.features?.pollMs ?? 1000;
    if (primaryDirectory !== this.primary.directory || primaryPollMs !== this.primary.pollMs || primaryDirectory && !this.primary.features) {
      await this.primary.features?.stopIntake(); await this.primary.features?.close();
      this.primary.features = undefined; this.primary.directory = primaryDirectory; this.primary.pollMs = primaryPollMs;
      try { this.primary.features = attachProjectFeatureFolder(this.workspace, this.primary); await this.primary.features?.init(); }
      catch (error) { await this.primary.features?.close(); this.primary.features = undefined; throw error; }
    }
    const primaryRepository = this.primary.sharedRuntime.intake.binding?.repositoryId;
    const assignments = this.workspace.settings.value.repositories.items.filter(item => resolve(item.path) !== this.primary.repository && item.id !== primaryRepository);
    for (const [id, previous] of this.additional) {
      const next = assignments.find(item => item.id === id);
      const directory = next?.features ? join(next.path, next.features.directory) : undefined;
      if (next && resolve(next.path) === previous.repository && directory === previous.directory && (next.features?.pollMs ?? 1000) === previous.pollMs) continue;
      await previous.features?.stopIntake(); await previous.sharedRuntime.close(); await previous.features?.close(); this.additional.delete(id);
    }
    for (const item of assignments) if (!this.additional.has(item.id)) {
      const stateDirectory = join(this.workspace.config.stateDir, 'p', createHash('sha256').update(item.id).digest('hex').slice(0, 16));
      await ensureDirectory(stateDirectory);
      const project = createProjectFeatureRuntime(this.workspace, { id: item.id, primary: false, repository: item.path, stateDirectory,
        ...(item.features ? { directory: join(item.path, item.features.directory) } : {}), pollMs: item.features?.pollMs ?? 1000 });
      try { await project.sharedRuntime.intake.init(); await project.features?.init(); }
      catch (error) { await project.sharedRuntime.close(); await project.features?.close(); throw error; }
      this.additional.set(item.id, project);
      const intake: SharedFeatureIntake = project.sharedRuntime.intake;
      if (this.running) intake.start();
    }
  }
  start() {
    this.running = true;
    for (const project of this.all()) {
      const intake: SharedFeatureIntake = project.sharedRuntime.intake;
      intake.start();
    }
  }
  async tick(force = false) { await Promise.all(this.all().map(project => project.features?.tick(force))); }
  async stopIntake() { await Promise.all(this.all().map(project => project.features?.stopIntake())); }
  async closeShared() { this.running = false; await Promise.all(this.all().map(project => project.sharedRuntime.close())); }
  async closeFeatures() { await Promise.all(this.all().map(project => project.features?.close())); }
}
