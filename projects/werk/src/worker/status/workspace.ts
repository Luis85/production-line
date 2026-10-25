import { featureTemplateView } from './workspace-feature-templates.js';
import { tickAutomaticPublication } from './workspace-automatic-publication.js';
import { managedProjectsView, managedProjectCommand } from './workspace-managed-projects.js';
import { assertNativeWorkReady } from './workspace-native-work.js';
import { processStatus, processCommand } from './workspace-processes.js';
import type { FeatureAuthoringCommand, FeatureAuthoringResult } from '../application/feature-authoring-contracts.js';
import type { FeatureActionResult } from '../application/feature-management.js';
import { assertDirectFeatureCreation, authorFeature, isSharedFeatureSession } from './workspace-feature-authoring.js';
import { WorkspaceContext, type WorkspaceConfiguration } from './workspace-context.js';
import type { ToolAccessView } from '../application/tool-policy.js';
import { type Task } from "../../shared/contracts.js";
import { isAbsolute } from "node:path";
import { DomainError } from "../../shared/errors.js";
import type { SnapshotJournal } from "../infrastructure/journal/snapshots.js";
import type { Status } from "./server.js";
import { task } from './workspace-tasks.js';
import { withFeatureTracking, taskDetail, chatSnapshot, cancelChat, chatSession, featureTrackingCommand, taskboardDetail, taskboardAction, startChat } from './workspace-task-views.js';
import { capabilities, requestCommand, resourceEvents, runEvidence } from './workspace-requests.js';
import { interaction } from './workspace-interactions.js';
import { sharedIntakeView, sharedIntakeCommand, featureView, featureList, featureCommand, rememberTask } from './workspace-features.js';
import { repositoryStatus, repositoryCommand, worktrees, pruneWorktrees } from './workspace-repositories.js';
import { providerStatus, providerAccount, toolAccess, updateToolAccess, discoverToolAccess, withIdleConfiguration, withRepositoryAdmission, updateSettings, integrations } from './workspace-settings.js';
import { environment, history } from './workspace-environment.js';
import { init, startNativeWork, close, closeEvidence, authenticate } from './workspace-lifecycle.js';

export function chatConfiguration(value: unknown): string | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DomainError("invalid_input", "chat must contain codexExecutable");
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).length !== 1 ||
    typeof raw.codexExecutable !== "string" ||
    !isAbsolute(raw.codexExecutable) ||
    raw.codexExecutable.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(raw.codexExecutable)
  )
    throw new DomainError(
      "invalid_input",
      "chat.codexExecutable must be an absolute path",
    );
  if (process.platform !== "linux")
    throw new DomainError(
      "invalid_input",
      "Codex chat currently requires native Linux",
    );
  return raw.codexExecutable;
}

/** Public worker facade. State, resources and command coordination have one owner. */
export class WorkerWorkspace {
  private readonly context: WorkspaceContext;
  constructor(config: WorkspaceConfiguration, journal: SnapshotJournal, get: () => Status) {
    this.context = new WorkspaceContext(config, journal, get);
  }
  private observed<T>(operation: () => T): T { return this.context.processObservations.run({}, operation); }
  get nativeWorkReady() { return this.context.nativeWorkState === 'ready'; }
  get executionProfiles() { return this.context.executionProfiles; }
  async tickFeatures(force = false) { await this.context.featureProjects.tick(force); await tickAutomaticPublication(this.context); }
  get featureTracking() { return this.context.featureTracking; }
  get sharedRuntime() { return this.context.sharedRuntime; }
  get repositories() { return this.context.repositories; }
  get repositoryDiscovery() { return this.context.repositoryDiscovery; }
  get resources() { return this.context.resources; }
  get consumption() { return this.context.consumption; }
  get reviews() { return this.context.reviews; }
  get settings() { return this.context.settings; }
  get sessions() { return this.context.sessions; }
  get board() { return this.context.board; }
  get accessScope() { return this.context.accessScope; }
  get definitions() { return this.context.definitions; }
  get chat() { return this.context.chat; }
  get executor() { return this.context.executor; }
  withFeatureTracking<T>(action: () => Promise<T>): Promise<T> { return this.observed(() => withFeatureTracking(this.context, action)); }
  taskDetail(id: string) { return taskDetail(this.context, id); }
  chatSnapshot(id = this.sessions.current.id) { return chatSnapshot(this.context, id); }
  cancelChat() { return cancelChat(this.context); }
  chatSession() { return chatSession(this.context); }
  featureTrackingCommand(input: unknown) { return featureTrackingCommand(this.context, input); }
  taskboardDetail(id: string) { return taskboardDetail(this.context, id); }
  taskboardAction(input: unknown) { return taskboardAction(this.context, input); }
  startChat(message: unknown) { return this.observed(() => startChat(this.context, message)); }
  capabilities() { return capabilities(this.context); }
  requestCommand(input: unknown) { return requestCommand(this.context, input); }
  processStatus() { return processStatus(this.context); }
  processCommand(input: unknown) { return processCommand(this.context, input); }
  resourceEvents(input: unknown) { return resourceEvents(this.context, input); }
  integrations(input: unknown = { action: "status" }) { return integrations(this.context, input); }
  interaction(input: unknown) { return this.observed(() => interaction(this.context, input)); }
  runEvidence(input: unknown) { return runEvidence(this.context, input); }
  task(input: unknown) { return this.observed(() => task(this.context, input)); }
  init(options: { deferNativeWork?: boolean } = {}) { return this.observed(() => init(this.context, options)); }
  startNativeWork() { return this.observed(() => startNativeWork(this.context)); }
  providerStatus(input: unknown) { return providerStatus(this.context, input); }
  providerAccount(input: unknown) { return providerAccount(this.context, input); }
  sharedIntakeView(projectId?: string) { return sharedIntakeView(this.context, projectId); }
  sharedIntakeCommand(input: unknown) { return this.observed(() => sharedIntakeCommand(this.context, input)); }
  featureTemplateView(projectId?: string) { return featureTemplateView(this.context, projectId); }
  featureView(projectId?: string) { return featureView(this.context, projectId); }
  featureList(projectId?: string) { return featureList(this.context, projectId); }
  featureCommand(input: FeatureAuthoringCommand): Promise<FeatureAuthoringResult>;
  featureCommand(input: { action: 'dependency_plan'; projectId?: string; id: string }): Promise<import('../application/delivery-dependency-plan.js').DeliveryDependencyPlan>;
  featureCommand(input: unknown): Promise<FeatureActionResult>;
  featureCommand(input: unknown) {
    const action = (input as { action?: unknown } | null)?.action;
    if (action === 'templates') return featureTemplateView(this.context, (input as { projectId?: string }).projectId);
    return this.observed(() => action === 'prepare' || action === 'publish' ? authorFeature(this.context, input) : featureCommand(this.context, input));
  }
  createTaskboard(input: unknown) {
    assertNativeWorkReady(this.context);
    assertDirectFeatureCreation(this.context, input);
    return this.observed(() => withRepositoryAdmission(this.context, () => this.board.create(input)));
  }
  async sessionCommand(input: unknown) {
    const body = input as { action?: unknown; id?: unknown } | null;
    if (body?.action === 'create') assertDirectFeatureCreation(this.context, input);
    if (body?.action === 'rename' && typeof body.id === 'string' && isSharedFeatureSession(this.context, body.id))
      throw new DomainError('conflict', 'This title belongs to the published Feature Request. Its accepted scope and title remain fixed.');
    const result = await this.sessions.action(input);
    await this.context.processes?.reconcileGrants();
    return result;
  }
  managedProjectsView() { return managedProjectsView(this.context); }
  managedProjectCommand(input: unknown) { return this.observed(() => managedProjectCommand(this.context, input)); }
  repositoryStatus() { return repositoryStatus(this.context); }
  repositoryCommand(input: unknown) { return this.observed(() => repositoryCommand(this.context, input)); }
  toolAccess(): ToolAccessView { return toolAccess(this.context); }
  updateToolAccess(input: unknown) { return updateToolAccess(this.context, input); }
  discoverToolAccess(input: unknown) { return discoverToolAccess(this.context, input); }
  withIdleConfiguration<T>(operation: () => Promise<T>): Promise<T> { return withIdleConfiguration(this.context, operation); }
  withRepositoryAdmission<T>(operation: () => Promise<T>): Promise<T> { return withRepositoryAdmission(this.context, operation); }
  worktrees() { return this.observed(() => worktrees(this.context)); }
  pruneWorktrees(input: unknown) { return this.observed(() => pruneWorktrees(this.context, input)); }
  updateSettings(body: unknown) { return this.observed(() => updateSettings(this.context, body)); }
  close(options: { deferEvidence?: boolean } = {}): Promise<void> { return close(this.context, options); }
  closeEvidence(): Promise<void> { return closeEvidence(this.context); }
  rememberTask(task: Task) { return rememberTask(this.context, task); }
  authenticate(token: string) { return authenticate(this.context, token); }
  environment() { return environment(this.context); }
  history() { return history(this.context); }
}
