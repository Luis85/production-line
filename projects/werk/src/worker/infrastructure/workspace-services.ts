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
import { definitionStorage, sessionCatalogStorage, localTaskStorage, approvedTaskFiles } from './journal/workspace-files.js';

/** Concrete provider/tool construction stays at the worker edge. Each call observes current grants. */
export function workspaceModelFactory(directory: string, settings: WorkerSettingsPort, model: typeof modelFor = modelFor, consumption?: ConsumptionRuntime): ModelFactory {
  return (connection, scope) => {
    const executionDirectory = !scope?.sessionId || scope.sessionId === 'default' ? directory : join(directory, 'sessions', scope.sessionId);
    const instance = model(connection, executionDirectory, undefined, scope ? {
      tools: () => createToolRuntime({ policy: settings.toolPolicy(), currentRevision: () => settings.toolPolicy().revision, directory: executionDirectory, worktree: scope.worktree, worktreeIdentity: scope.worktreeIdentity }),
    } : undefined);
    return consumption ? consumptionModel(instance, consumption) : instance;
  };
}
export function createWorkerDefinitions(directory: string) { return new WorkerDefinitions(definitionStorage(directory)); }
export function createWorkerSessions(directory: string, settings: WorkerSettingsPort, model: typeof modelFor = modelFor, requests?: RequestJournal, activeOutsideChat: () => number = () => 0, consumption?: ConsumptionRuntime, capacity?: Pick<WorkerCapacityContext, 'remote'>) {
  return new WorkerSessions(settings, {
    model: workspaceModelFactory(directory, settings, model, consumption), storage: sessionCatalogStorage(directory),
    consumptionBlocked: consumption ? () => consumption.status().blocked : undefined,
    capacity: capacity ? { remote: capacity.remote, consumption: () => consumption?.status() ?? null } : undefined,
    requests: requests ?? new WorkerRequestJournal(directory), interactions: new WorkerInteractionJournal(directory), runs: new WorkerRunJournal(directory),
    definitions: createWorkerDefinitions(directory), activeOutsideChat,
  });
}
export function createLocalTaskboard(directory: string, settings: WorkerSettingsPort, sessions: WorkerSessions, modelOrWorkspaces: typeof modelFor | LocalTaskWorkspaces = modelFor, workspaces?: LocalTaskWorkspaces, consumption?: ConsumptionRuntime) {
  const model = typeof modelOrWorkspaces === 'function' ? modelOrWorkspaces : modelFor;
  return new LocalTaskboard(settings, sessions, {
    model: workspaceModelFactory(directory, settings, model, consumption), storage: localTaskStorage(directory), files: approvedTaskFiles,
    workspaces: typeof modelOrWorkspaces === 'function' ? workspaces : modelOrWorkspaces,
  });
}
