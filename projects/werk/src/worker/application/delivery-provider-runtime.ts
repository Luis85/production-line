import type { DeliveryTaskHost } from './delivery-step-boundary.js';
import type { LocalTask } from './local-task-contracts.js';
import type { DevelopmentRuntime } from './development.js';
import type { ConversationModel } from './conversation.js';
import { interactionFeatureRequest } from './feature-request-reference.js';
import { validateDeliveryExecutionSnapshot } from './delivery-execution-snapshot.js';
import { selectedConnection } from './model-selection.js';
import { executeModel, legacyModelReply, prepareModelRequest, type ModelRequest, type StructuredModel } from './model-contract.js';
import { gateDigest } from './request-gates.js';
export function deliveryExecution(host: Pick<DeliveryTaskHost, 'sessions'>, task: LocalTask) {
  const context = task.requestId ? host.sessions.requests.get(task.requestId).input.context as { deliveryExecution?: unknown } : undefined;
  return context?.deliveryExecution ? validateDeliveryExecutionSnapshot(context.deliveryExecution) : undefined;
}
export function deliveryProfileModel(host: Pick<DeliveryTaskHost, 'model' | 'settings'>, task: LocalTask, accepted: NonNullable<ReturnType<typeof deliveryExecution>>, profileId: string, development?: DevelopmentRuntime, logicalSessionId?: string) {
  const snapshot = accepted.profileSnapshots.find(item => item.profileId === profileId);
  if (!snapshot) throw Error('The accepted execution profile is unavailable.');
  const connection = selectedConnection(host.settings.provider(snapshot.selection.provider), snapshot.selection, snapshot.definition);
  const model = host.model(connection, logicalSessionId ? { sessionId: logicalSessionId, feature: task.feature ?? interactionFeatureRequest(task.id), baseCommit: task.baseCommit, worktree: task.worktree, worktreeIdentity: task.worktreeIdentity, development } : undefined);
  if (!model) throw Error('The accepted execution provider is not available on this host.');
  return { model, snapshot };
}
/** Freeze the original resource limits while the target adapter supplies its explicitly authorized permission boundary. */
export function prepareHandoffDispatch(model: ConversationModel, previous: ModelRequest, message: string): ModelRequest {
  const typed = model as Partial<StructuredModel>;
  const frozen: StructuredModel = {
    configuration: typed.configuration!, capabilities: typed.capabilities!, sessionBinding: typed.sessionBinding,
    executionPolicy: previous.policy,
    toolManifestFor: policy => typed.toolManifestFor?.(policy) ?? typed.toolManifest,
    reply: (...args) => legacyModelReply(frozen, ...args), execute: (...args) => executeModel(model, ...args),
  };
  const next = prepareModelRequest(frozen, [...previous.messages, { id: 'handoff-context', role: 'user', state: 'complete', at: new Date().toISOString(), text: message }], previous.operation, previous.policy.maxRuntimeMs);
  if (!!next.policy.development !== !!previous.policy.development || (next.toolManifest?.revision !== previous.toolManifest?.revision || next.toolManifest?.tools.some(tool => !previous.toolManifest?.tools.some(prior => gateDigest(prior) === gateDigest(tool))) || gateDigest(next.toolManifest?.limits ?? null) !== gateDigest(previous.toolManifest?.limits ?? null))) throw Error('Worker tool grants changed after admission. Restore the accepted grants before handoff.');
  return next;
}
