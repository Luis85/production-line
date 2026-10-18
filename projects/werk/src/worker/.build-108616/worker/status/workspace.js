                                                                                                                     
                                                                                
import { assertDirectFeatureCreation, authorFeature, isSharedFeatureSession } from './workspace-feature-authoring.js';
import { WorkspaceContext,                             } from './workspace-context.js';
                                                                    
import {           } from "../../shared/contracts.js";
import { isAbsolute } from "node:path";
import { DomainError } from "../../shared/errors.js";
                                                                              
                                          
import { task } from './workspace-tasks.js';
import { withFeatureTracking, taskDetail, chatSnapshot, cancelChat, chatSession, featureTrackingCommand, taskboardDetail, taskboardAction, startChat } from './workspace-task-views.js';
import { capabilities, requestCommand, resourceEvents, runEvidence } from './workspace-requests.js';
import { interaction } from './workspace-interactions.js';
import { sharedIntakeView, sharedIntakeCommand, featureView, featureList, featureCommand, rememberTask } from './workspace-features.js';
import { repositoryStatus, repositoryCommand, worktrees, pruneWorktrees } from './workspace-repositories.js';
import { providerStatus, providerAccount, toolAccess, updateToolAccess, discoverToolAccess, withIdleConfiguration, withRepositoryAdmission, updateSettings, integrations } from './workspace-settings.js';
import { environment, history } from './workspace-environment.js';
import { init, close, closeEvidence, authenticate } from './workspace-lifecycle.js';

export function chatConfiguration(value         )                     {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DomainError("invalid_input", "chat must contain codexExecutable");
  const raw = value                           ;
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
                   context                  ;
  constructor(config                        , journal                 , get              ) {
    this.context = new WorkspaceContext(config, journal, get);
  }
  get executionProfiles() { return this.context.executionProfiles; }
  get features() { return this.context.features; }
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
  withFeatureTracking   (action                  )             { return withFeatureTracking(this.context, action); }
  taskDetail(id        ) { return taskDetail(this.context, id); }
  chatSnapshot(id = this.sessions.current.id) { return chatSnapshot(this.context, id); }
  cancelChat() { return cancelChat(this.context); }
  chatSession() { return chatSession(this.context); }
  featureTrackingCommand(input         ) { return featureTrackingCommand(this.context, input); }
  taskboardDetail(id        ) { return taskboardDetail(this.context, id); }
  taskboardAction(input         ) { return taskboardAction(this.context, input); }
  startChat(message         ) { return startChat(this.context, message); }
  capabilities() { return capabilities(this.context); }
  requestCommand(input         ) { return requestCommand(this.context, input); }
  resourceEvents(input         ) { return resourceEvents(this.context, input); }
  integrations(input          = { action: "status" }) { return integrations(this.context, input); }
  interaction(input         ) { return interaction(this.context, input); }
  runEvidence(input         ) { return runEvidence(this.context, input); }
  task(input         ) { return task(this.context, input); }
  init() { return init(this.context); }
  providerStatus(input         ) { return providerStatus(this.context, input); }
  providerAccount(input         ) { return providerAccount(this.context, input); }
  sharedIntakeView() { return sharedIntakeView(this.context); }
  sharedIntakeCommand(input         ) { return sharedIntakeCommand(this.context, input); }
  featureView() { return featureView(this.context); }
  featureList() { return featureList(this.context); }
                                                                                  
                                                               
  featureCommand(input         ) {
    const action = (input                               )?.action;
    return action === 'prepare' || action === 'publish' ? authorFeature(this.context, input) : featureCommand(this.context, input);
  }
  createTaskboard(input         ) {
    assertDirectFeatureCreation(this.context);
    return withRepositoryAdmission(this.context, () => this.board.create(input));
  }
  sessionCommand(input         ) {
    const body = input                                             ;
    if (body?.action === 'create') assertDirectFeatureCreation(this.context);
    if (body?.action === 'rename' && typeof body.id === 'string' && isSharedFeatureSession(this.context, body.id))
      throw new DomainError('conflict', 'This title belongs to the published Feature Request. Its accepted scope and title remain fixed.');
    return this.sessions.action(input);
  }
  repositoryStatus() { return repositoryStatus(this.context); }
  repositoryCommand(input         ) { return repositoryCommand(this.context, input); }
  toolAccess()                 { return toolAccess(this.context); }
  updateToolAccess(input         ) { return updateToolAccess(this.context, input); }
  discoverToolAccess(input         ) { return discoverToolAccess(this.context, input); }
  withIdleConfiguration   (operation                  )             { return withIdleConfiguration(this.context, operation); }
  withRepositoryAdmission   (operation                  )             { return withRepositoryAdmission(this.context, operation); }
  worktrees() { return worktrees(this.context); }
  pruneWorktrees(input         ) { return pruneWorktrees(this.context, input); }
  updateSettings(body         ) { return updateSettings(this.context, body); }
  close(options                              = {})                { return close(this.context, options); }
  closeEvidence()                { return closeEvidence(this.context); }
  rememberTask(task      ) { return rememberTask(this.context, task); }
  authenticate(token        ) { return authenticate(this.context, token); }
  environment() { return environment(this.context); }
  history() { return history(this.context); }
}
