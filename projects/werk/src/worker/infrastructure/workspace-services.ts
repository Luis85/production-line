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
export function workspaceModelFactory(directory: string, settings: ModelSettings, model: WorkspaceProviderFactory = modelFor, consumption?: ConsumptionRuntime): ModelFactory {
  return (connection, scope) => {
    const executionDirectory = !scope?.sessionId || scope.sessionId === 'default' ? directory : join(directory, 'sessions', scope.sessionId);
    const instance = model(connection, executionDirectory, undefined, scope ? {
      tools: policy => createToolRuntime({
        policy: settings.toolPolicy(), currentRevision: () => settings.toolPolicy().revision,
        directory: executionDirectory, worktree: scope.worktree, worktreeIdentity: scope.worktreeIdentity, development: scope.development, repositories: () => settings.value.repositories.items,
        maxCalls: policy ? policy.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS : settings.value.execution.maxToolCalls,
        maxRuntimeMs: policy ? policy.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS : settings.value.execution.maxRuntimeMs,
        commandTimeoutMs: policy ? policy.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS : settings.value.execution.commandTimeoutMs,
        ...candidateLimits(policy ?? settings.value.execution),
      }),
    } : undefined);
    const budgeted: StructuredModel | undefined = instance ? {
      get configuration() { return instance.configuration ?? { id: 'legacy', model: '', instruction: '' }; },
      get capabilities() { return instance.capabilities ?? modelCapabilities; },
      get toolManifest() { return instance.toolManifest; },
      toolManifestFor(policy) { return instance.toolManifestFor ? instance.toolManifestFor(policy) : instance.toolManifest; },
      get executionPolicy() { return { maxToolCalls: settings.value.execution.maxToolCalls, commandTimeoutMs: settings.value.execution.commandTimeoutMs, ...candidateLimits(settings.value.execution) }; },
      reply: (...args) => legacyModelReply(budgeted!, ...args),
      execute: (...args) => executeModel(instance, ...args),
    } : undefined;
    return consumption ? consumptionModel(budgeted, consumption) : budgeted;
  };
}
export function createWorkerDefinitions(directory: string) { return new WorkerDefinitions(definitionStorage(directory)); }
export function createWorkerSessions(directory: string, settings: WorkerSettingsPort, model: WorkspaceProviderFactory = modelFor, requests?: RequestJournal, activeOutsideChat: () => number = () => 0, consumption?: ConsumptionRuntime, capacity?: Pick<WorkerCapacityContext, 'remote'>) {
  return new WorkerSessions(settings, {
    model: workspaceModelFactory(directory, settings, model, consumption), storage: sessionCatalogStorage(directory),
    consumptionBlocked: consumption ? () => consumption.status().blocked : undefined,
    capacity: capacity ? { remote: capacity.remote, consumption: () => consumption?.status() ?? null } : undefined,
    requests: requests ?? new WorkerRequestJournal(directory), interactions: new WorkerInteractionJournal(directory), runs: new WorkerRunJournal(directory),
    definitions: createWorkerDefinitions(directory), activeOutsideChat,
  });
}
export function createLocalTaskboard(directory: string, settings: WorkerSettingsPort, sessions: WorkerSessions, modelOrWorkspaces: WorkspaceProviderFactory | LocalTaskWorkspaces = modelFor, workspaces?: LocalTaskWorkspaces, consumption?: ConsumptionRuntime) {
  const model = typeof modelOrWorkspaces === 'function' ? modelOrWorkspaces : modelFor;
  return new LocalTaskboard(settings, sessions, {
    model: workspaceModelFactory(directory, settings, model, consumption), storage: localTaskStorage(directory), files: approvedTaskFiles, development: createDevelopmentRuntime,
    workspaces: typeof modelOrWorkspaces === 'function' ? workspaces : modelOrWorkspaces,
  });
}
