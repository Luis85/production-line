import { selectedConnection, validateModelSelection, type ModelSelection } from './model-selection.js';
import type { LocalTask } from './local-task-contracts.js';
import type { ProviderConnection } from './provider-contract.js';
import type { WorkerRequest } from './request-gates.js';
import { gateDigest } from './request-gates.js';

/** Legacy file tasks already retained their model. Never migrate them from live defaults. */
export function localTaskSelection(task: Pick<LocalTask, 'provider' | 'model' | 'selection'>): ModelSelection {
  const selection = validateModelSelection(task.selection ?? { provider: task.provider, model: task.model, effort: 'default' });
  if (selection.provider !== task.provider || selection.model !== task.model) throw Error('Saved task model selection differs from its accepted provider.');
  return selection;
}
export function localTaskConnection(connection: ProviderConnection, task: LocalTask): ProviderConnection {
  return selectedConnection(connection, localTaskSelection(task), task.definition);
}
export function validateTaskSelection(task: LocalTask, request?: WorkerRequest) {
  const selection = localTaskSelection(task);
  const accepted = request?.input.context as { selection?: unknown } | undefined;
  if (task.selection !== undefined || accepted?.selection !== undefined) {
    if (!task.selection || request && (!accepted?.selection || gateDigest(selection) !== gateDigest(validateModelSelection(accepted.selection))))
      throw Error('Saved task model selection differs from the accepted request context.');
  }
  if (request && request.provider.id !== 'legacy' && (request.provider.id !== selection.provider || request.provider.model !== selection.model || (request.provider.effort ?? 'default') !== selection.effort))
    throw Error('Saved task model selection differs from its accepted dispatch provider.');
}
