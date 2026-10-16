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
export function workspaceModelFactory(directory: string, settings: WorkerSettingsPort, model: typeof modelFor = modelFor): ModelFactory {
  return (connection, scope) => {
    const executionDirectory = !scope?.sessionId || scope.sessionId === 'default' ? directory : join(directory, 'sessions', scope.sessionId);
    return model(connection, executionDirectory, undefined, scope ? {
      tools: () => createToolRuntime({ policy: settings.toolPolicy(), currentRevision: () => settings.toolPolicy().revision, directory: executionDirectory, worktree: scope.worktree, worktreeIdentity: scope.worktreeIdentity }),
    } : undefined);
  };
}
export function createWorkerDefinitions(directory: string) { return new WorkerDefinitions(definitionStorage(directory)); }
export function createWorkerSessions(directory: string, settings: WorkerSettingsPort, model: typeof modelFor = modelFor, requests?: RequestJournal, activeOutsideChat: () => number = () => 0) {
  return new WorkerSessions(settings, {
    model: workspaceModelFactory(directory, settings, model), storage: sessionCatalogStorage(directory),
    requests: requests ?? new WorkerRequestJournal(directory), interactions: new WorkerInteractionJournal(directory), runs: new WorkerRunJournal(directory),
    definitions: createWorkerDefinitions(directory), activeOutsideChat,
  });
}
export function createLocalTaskboard(directory: string, settings: WorkerSettingsPort, sessions: WorkerSessions, modelOrWorkspaces: typeof modelFor | LocalTaskWorkspaces = modelFor, workspaces?: LocalTaskWorkspaces) {
  const model = typeof modelOrWorkspaces === 'function' ? modelOrWorkspaces : modelFor;
  return new LocalTaskboard(settings, sessions, {
    model: workspaceModelFactory(directory, settings, model), storage: localTaskStorage(directory), files: approvedTaskFiles,
    workspaces: typeof modelOrWorkspaces === 'function' ? workspaces : modelOrWorkspaces,
  });
}
