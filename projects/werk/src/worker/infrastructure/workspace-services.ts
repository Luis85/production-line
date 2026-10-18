import { workspaceProcessTools, type WorkspaceProcessTools } from './workspace-process-tools.js';
import { workspaceDelegation } from './workspace-delegation.js';
import type { RunJournal } from '../application/journal-ports.js';
import type { ToolRuntime } from '../application/tool-runtime.js';
import type { ModelRequest } from '../application/model-contract.js';
import { validateFeatureRequestReference } from '../application/feature-request-reference.js';
import { validateModelSessionBinding, type ModelSessionBinding } from '../application/model-session.js';
import { FileModelSessionStore } from './model-session-store.js';
import { sessionHistoryTool } from './session-history-tool.js';
import { loadProjectModelContext } from './project-model-context.js';
import type { ConversationModel } from '../application/conversation.js';
import type { WorkerCapacityContext } from '../application/worker-capacity.js';
import type { ConsumptionRuntime } from '../application/consumption.js';
import { consumptionModel } from '../application/consumption-model.js';
import { join } from 'node:path';
import { WorkerSessions } from '../application/sessions.js';
import { LocalTaskboard, type LocalTaskWorkspaces } from '../application/local-tasks.js';
import { WorkerDefinitions } from '../application/definitions.js';
import type { WorkerSettingsPort } from '../application/workspace-ports.js';
import type { ModelFactory } from '../application/provider-contract.js';
import type { RequestJournal } from '../application/journal-ports.js';
import { WorkerRequestJournal } from './journal/requests.js';
import { WorkerInteractionJournal } from './journal/interactions.js';
import { WorkerRunJournal } from './journal/local-runs.js';
import { initializeLocalEvidence } from './journal/startup.js';
import { modelFor } from './providers.js';
import { createToolRuntime } from './tool-runtime.js';
import { createDevelopmentRuntime } from './candidate-tools.js';
import { executeModel, legacyModelReply, modelCapabilities, type StructuredModel } from '../application/model-contract.js';
import { DEFAULT_MAX_RUNTIME_MS, DEFAULT_MAX_TOOL_CALLS, DEFAULT_COMMAND_TIMEOUT_MS, candidateInspectionFields, type CandidateInspectionLimits } from '../application/execution-policy.js';
import { definitionStorage, sessionCatalogStorage, localTaskStorage, approvedTaskFiles } from './journal/workspace-files.js';

type ModelSettings = Pick<WorkerSettingsPort, 'toolPolicy'> & { readonly value: Pick<WorkerSettingsPort['value'], 'execution' | 'repositories'> };
/** Frozen dispatch values, else current settings. Absent dispatch values resolve to defaults in the runtime. */
const candidateLimits = (source: Partial<CandidateInspectionLimits>): Partial<CandidateInspectionLimits> => Object.fromEntries(candidateInspectionFields.filter(field => source[field] !== undefined).map(field => [field, source[field]]));
export type WorkspaceProviderFactory = (...args: Parameters<typeof modelFor>) => (ConversationModel & Partial<StructuredModel>) | undefined;

/** Concrete provider/tool construction stays at the worker edge. Each call observes current grants. */
export function workspaceModelFactory(directory: string, settings: ModelSettings, model: WorkspaceProviderFactory = modelFor, consumption?: ConsumptionRuntime, runs?: RunJournal, processes?: WorkspaceProcessTools): ModelFactory {
  return (connection, scope) => {
    const executionDirectory = !scope?.sessionId || scope.sessionId === 'default' ? directory : join(directory, 'sessions', scope.sessionId);
    const binding: ModelSessionBinding | undefined = scope?.sessionId && scope.feature ? { schemaVersion: 1, logicalSessionId: scope.sessionId, featureRequestKey: validateFeatureRequestReference(scope.feature).key, providerId: connection.id, generation: 1 } : undefined;
    if (binding) validateModelSessionBinding(binding);
    const processTools = workspaceProcessTools(processes, scope, runs);
    let dispatch: ModelRequest | undefined;
    const instance = model(connection, executionDirectory, undefined, scope ? {
      ...(binding ? { session: { binding, store: new FileModelSessionStore(directory) } } : {}),
      tools: policy => {
        let runtime: ToolRuntime;
        const additionalOperations = binding && policy?.sessionContext ? [sessionHistoryTool(directory, binding)] : [];
        additionalOperations.push(...processTools.tools(settings.toolPolicy()));
        const grant = settings.toolPolicy().delegation;
        if (binding && policy?.sessionContext && grant?.enabled && runs) {
          const delegated = workspaceDelegation({ directory, binding, connection: { ...connection, ...(dispatch ? { model: dispatch.provider.model, instruction: dispatch.provider.instruction } : {}) }, grant, acceptedScope: dispatch?.messages[0]?.text, runtime: () => runtime, runs, consumption, model, observations: processes?.observations });
          if (delegated) additionalOperations.push(delegated);
        }
        runtime = createToolRuntime({
        additionalOperations,
        policy: settings.toolPolicy(), currentRevision: () => settings.toolPolicy().revision,
        directory: executionDirectory, worktree: scope.worktree, worktreeIdentity: scope.worktreeIdentity, development: scope.development, repositories: () => settings.value.repositories.items,
        maxCalls: policy ? policy.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS : settings.value.execution.maxToolCalls,
        maxRuntimeMs: policy ? policy.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS : settings.value.execution.maxRuntimeMs,
        commandTimeoutMs: policy ? policy.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS : settings.value.execution.commandTimeoutMs,
        ...candidateLimits(policy ?? settings.value.execution),
        });
        return runtime;
      },
    } : undefined);
    const budgeted: StructuredModel | undefined = instance ? {
      get sessionBinding() { return instance.configuration?.id === binding?.providerId ? binding : undefined; },
      loadProjectContext(signal) { return scope?.worktree && scope.baseCommit ? loadProjectModelContext(scope.worktree, scope.baseCommit, signal) : Promise.resolve(null); },
      get configuration() { return instance.configuration ?? { id: 'legacy', model: '', instruction: '' }; },
      get capabilities() { return instance.capabilities ?? modelCapabilities; },
      get toolManifest() { return instance.toolManifest; },
      toolManifestFor(policy) { return instance.toolManifestFor ? instance.toolManifestFor(policy) : instance.toolManifest; },
      get executionPolicy() { return { maxToolCalls: settings.value.execution.maxToolCalls, commandTimeoutMs: settings.value.execution.commandTimeoutMs, ...candidateLimits(settings.value.execution) }; },
      reply: (...args) => legacyModelReply(budgeted!, ...args),
      execute: (...args) => { dispatch = args[0]; return processTools.execute(() => executeModel(instance, ...args), args[1]); },
    } : undefined;
    return consumption ? consumptionModel(budgeted, consumption) : budgeted;
  };
}
export function createWorkerDefinitions(directory: string) { return new WorkerDefinitions(definitionStorage(directory)); }
export function createWorkerSessions(directory: string, settings: WorkerSettingsPort, model: WorkspaceProviderFactory = modelFor, requests?: RequestJournal, activeOutsideChat: () => number = () => 0, consumption?: ConsumptionRuntime, capacity?: Pick<WorkerCapacityContext, 'remote'>, processes?: WorkspaceProcessTools, auxiliary?: { active(): number; retainedSessionIds(): string[] }) {
  const requestJournal = requests ?? new WorkerRequestJournal(directory);
  const interactions = new WorkerInteractionJournal(directory), runs = new WorkerRunJournal(directory);
  return new WorkerSessions(settings, {
    model: workspaceModelFactory(directory, settings, model, consumption, runs, processes), storage: sessionCatalogStorage(directory),
    consumptionBlocked: consumption ? () => consumption.status().blocked : undefined,
    capacity: capacity ? { remote: capacity.remote, consumption: () => consumption?.status() ?? null } : undefined,
    requests: requestJournal, interactions, runs,
    initializeEvidence: requestJournal instanceof WorkerRequestJournal ? () => initializeLocalEvidence(directory, settings, requestJournal, interactions, runs) : undefined,
    definitions: createWorkerDefinitions(directory), activeOutsideChat, auxiliary,
  });
}
export function createLocalTaskboard(directory: string, settings: WorkerSettingsPort, sessions: WorkerSessions, modelOrWorkspaces: WorkspaceProviderFactory | LocalTaskWorkspaces = modelFor, workspaces?: LocalTaskWorkspaces, consumption?: ConsumptionRuntime, processes?: WorkspaceProcessTools) {
  const model = typeof modelOrWorkspaces === 'function' ? modelOrWorkspaces : modelFor;
  return new LocalTaskboard(settings, sessions, {
    model: workspaceModelFactory(directory, settings, model, consumption, sessions.runs, processes), storage: localTaskStorage(directory), files: approvedTaskFiles, development: createDevelopmentRuntime, observations: processes?.observations,
    workspaces: typeof modelOrWorkspaces === 'function' ? workspaces : modelOrWorkspaces,
  });
}
