import { defaultDeliveryRetention } from '../application/delivery-retention.js';
import { readDeliveryPolicyDraft, saveDeliveryPolicyDraft } from '../infrastructure/delivery-policy-draft.js';
import type { LocalTask } from '../application/local-task-contracts.js';
import { assertDeliveryPolicyApproved } from '../application/delivery-policy-approval.js';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { identifier, object } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import { deliveryPolicyApproved, deliveryPolicyRequiresApproval } from '../application/delivery-policy-approval.js';
import { readDeliveryPolicy } from '../infrastructure/delivery-policy.js';
import type { WorkspaceContext } from './workspace-context.js';

export const deliveryPolicyActions = ['delivery_projects', 'delivery_policy', 'approve_delivery_policy', 'revoke_delivery_policy', 'delivery_policy_draft', 'save_delivery_policy_draft'] as const;
const signalFor = (workspace: WorkspaceContext) => AbortSignal.any([workspace.repositoryStop.signal, AbortSignal.timeout(30000)]);
function selectedRepository(workspace: WorkspaceContext, projectId?: unknown) {
  if (projectId !== undefined) return workspace.repositories.resolve(identifier(projectId, 'Project ID'));
  const path = resolve(workspace.config.projectDir ?? process.cwd());
  return workspace.settings.value.repositories.items.find(item => resolve(item.path) === path);
}
/** Private machine authority is independent of repository-controlled policy and old pinned runs. */
export function authorizeDeliveryPolicy(workspace: WorkspaceContext, repositoryId: string, configurationDigest: string): void {
  workspace.repositories.resolve(identifier(repositoryId, 'Repository ID'));
  if (!/^[a-f0-9]{64}$/.test(configurationDigest) || !workspace.deliveryApprovals.view().approvals.some(item => item.repositoryId === repositoryId && item.configurationDigest === configurationDigest))
    throw new DomainError('conflict', 'This exact project delivery policy is not approved on this worker. Review it in Settings → Project delivery.');
}
async function deliveryPolicyView(workspace: WorkspaceContext, projectId?: unknown) {
  const repository = selectedRepository(workspace, projectId);
  const snapshot = await readDeliveryPolicy(repository?.path ?? resolve(workspace.config.projectDir ?? process.cwd()), signalFor(workspace));
  const state = workspace.deliveryApprovals.view(), approval = state.approvals.find(item => item.repositoryId === repository?.id && item.configurationDigest === snapshot.configurationDigest);
  return { ...snapshot, retention: snapshot.configuration.retention ?? defaultDeliveryRetention(), repositoryId: repository?.id ?? null, approvalRequired: deliveryPolicyRequiresApproval(snapshot.configuration),
    approved: repository ? deliveryPolicyApproved(state, repository.id, snapshot) : !deliveryPolicyRequiresApproval(snapshot.configuration),
    approvedAt: approval?.approvedAt ?? null, approvedVersions: state.approvals.filter(item => item.repositoryId === repository?.id).map(({ configurationDigest, approvedAt }) => ({ configurationDigest, approvedAt })), approvalRevision: state.revision, machineMaxParallel: workspace.settings.value.board.maxParallel };
}
export async function deliveryPolicyCommand(workspace: WorkspaceContext, input: unknown) {
  const raw = object(input, 'Project delivery policy command', ['action', 'projectId', 'repositoryId', 'configurationDigest', 'expectedApprovalRevision', 'expectedFileDigest', 'configuration']);
  if (raw.action === 'delivery_projects') {
    object(input, 'Project delivery list', ['action']);
    const primary = resolve(workspace.config.projectDir ?? process.cwd());
    return { schemaVersion: 1, approvalRevision: workspace.deliveryApprovals.view().revision, approvals: workspace.deliveryApprovals.view().approvals,
      projects: workspace.settings.value.repositories.items.map(item => ({ repositoryId: item.id, name: item.id, path: item.path, primary: resolve(item.path) === primary, intake: item.features ?? null })) };
  }
  if (raw.action === 'delivery_policy') { object(input, 'Project delivery policy', ['action', 'projectId']); return deliveryPolicyView(workspace, raw.projectId); }
  if (raw.action === 'delivery_policy_draft' || raw.action === 'save_delivery_policy_draft') {
    object(input, 'Project delivery draft', raw.action === 'delivery_policy_draft' ? ['action', 'projectId'] : ['action', 'projectId', 'expectedFileDigest', 'configuration']);
    const repository = selectedRepository(workspace, raw.projectId);
    if (!repository) throw new DomainError('conflict', 'Assign this repository before editing its delivery policy.');
    if (raw.action === 'save_delivery_policy_draft' && !workspace.acceptingTasks) throw new DomainError('unavailable', 'Worker is stopping.');
    const draft = raw.action === 'delivery_policy_draft' ? await readDeliveryPolicyDraft(repository.path, signalFor(workspace))
      : await saveDeliveryPolicyDraft(repository.path, raw.expectedFileDigest, raw.configuration, signalFor(workspace));
    return { repositoryId: repository.id, ...draft };
  }
  object(input, 'Project policy approval command', ['action', 'repositoryId', 'configurationDigest', 'expectedApprovalRevision']);
  if (raw.action !== 'approve_delivery_policy' && raw.action !== 'revoke_delivery_policy') throw new DomainError('invalid_input', 'Choose a supported project delivery policy action.');
  if (!workspace.acceptingTasks) throw new DomainError('unavailable', 'Worker is stopping.');
  const repositoryId = identifier(raw.repositoryId, 'Repository ID');
  if (raw.action === 'approve_delivery_policy') {
    const current = await deliveryPolicyView(workspace, repositoryId);
    if (current.configurationDigest !== raw.configurationDigest) throw new DomainError('conflict', 'Committed project policy changed. Reload and inspect its exact configuration before approving.');
  }
  const state = await workspace.deliveryApprovals.change({ action: raw.action === 'approve_delivery_policy' ? 'approve' : 'revoke', repositoryId,
    configurationDigest: raw.configurationDigest, expectedRevision: raw.expectedApprovalRevision });
  updatePolicyHolds(workspace, repositoryId, String(raw.configurationDigest), raw.action === 'approve_delivery_policy');
  return { schemaVersion: 1, approvalRevision: state.revision, approvals: state.approvals };
}
function updatePolicyHolds(workspace: WorkspaceContext, repositoryId: string, configurationDigest: string, approved: boolean) {
  const gates = workspace.sessions.requests;
  for (const task of workspace.board.view().tasks) {
    if (task.repositoryId !== repositoryId || !task.requestId) continue;
    const request = gates.get(task.requestId), context = request.input.context as { deliveryPolicy?: { configurationDigest?: string } } | undefined;
    if (context?.deliveryPolicy?.configurationDigest !== configurationDigest || !request.delivery || ['done', 'cancelled'].includes(request.phase)) continue;
    if (approved) { gates.deliveryUpdate(request.id, { action: 'clear_hold', code: 'policy_approval' }); continue; }
    const held = gates.deliveryUpdate(request.id, { action: 'hold', code: 'policy_approval', reason: 'Local approval for this pinned project policy was revoked. Active execution is being interrupted; inspect retained evidence before granting and resuming it.' });
    if (held.delivery?.allowedControls.includes('interrupt')) gates.command({ action: 'interrupt', requestId: held.id, expectedRevision: held.revision, deliveryRunId: held.delivery.id, inputRevision: held.inputRevision, operationId: randomUUID() });
  }
}

/** Rechecked at each dispatch/command boundary; a saved run never retains revoked authority. */
export function authorizeTaskDelivery(workspace: WorkspaceContext, task: LocalTask): void {
  if (!task.deliveryPolicy || !deliveryPolicyRequiresApproval(task.deliveryPolicy.configuration)) return;
  if (!task.repositoryId) throw new DomainError('conflict', 'Expanded project delivery requires an assigned repository.');
  workspace.repositories.resolve(task.repositoryId);
  assertDeliveryPolicyApproved(workspace.deliveryApprovals.view(), task.repositoryId, task.deliveryPolicy);
}
