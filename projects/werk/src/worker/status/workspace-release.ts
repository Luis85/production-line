import { DomainError } from '../../shared/errors.js';
import { releaseAccepted, releaseSubject, releaseView } from '../application/release-view.js';
import { runReleaseOperation } from '../application/release-runtime.js';
import type { ReleaseAuthority, ReleasePort } from '../application/release-contracts.js';
import type { RequestCommand } from '../application/request-gates.js';
import { createReleaseAdapter } from '../infrastructure/release-adapter.js';
import { authorizeDeliveryPolicy } from './workspace-delivery-policy.js';
import { assertNativeWorkReady } from './workspace-native-work.js';
import type { WorkspaceContext } from './workspace-context.js';

const active = new WeakMap<WorkspaceContext, Map<string, { repositoryId: string; promise: Promise<unknown> }>>();
function operations(workspace: WorkspaceContext) {
  let value = active.get(workspace);
  if (!value) { value = new Map(); active.set(workspace, value); }
  return value;
}
export async function closeReleases(workspace: WorkspaceContext) {
  await Promise.allSettled([...operations(workspace).values()].map(value => value.promise));
}
export async function requestReleaseView(workspace: WorkspaceContext, requestId: string) {
  const request = workspace.sessions.requests.get(requestId);
  let authorized = false, reason: string | null = null, busy = operations(workspace).has(requestId);
  try {
    const { repositoryId, snapshot } = releaseSubject(request);
    busy ||= [...operations(workspace).values()].some(value => value.repositoryId === repositoryId);
    await authorizeDeliveryPolicy(workspace, repositoryId, snapshot.configurationDigest);
    authorized = true;
  } catch (error) { reason = error instanceof DomainError ? error.message : 'The project release policy approval could not be confirmed.'; }
  return releaseView(request, authorized, reason, busy);
}
/** The request journal owns intent and receipts; composition owns bounded native processes. */
export async function releaseRequest(workspace: WorkspaceContext, input: RequestCommand, injected?: { port: ReleasePort; authority: ReleaseAuthority }) {
  assertNativeWorkReady(workspace);
  const running = operations(workspace), gates = workspace.sessions.requests;
  const subject = releaseSubject(gates.get(input.requestId));
  if ([...running.values()].some(value => value.repositoryId === subject.repositoryId))
    throw new DomainError('conflict', 'A release operation is active for this project. Wait for its recorded result.');
  const operation = Promise.resolve().then(async () => {
    const before = gates.get(input.requestId);
    const { snapshot, repositoryId, target } = releaseSubject(before);
    const authority: ReleaseAuthority = { authorize: async (id, digest, mutation) => {
      const checkStop = () => {
        if (!mutation) return;
        const current = gates.get(input.requestId);
        if (!workspace.acceptingTasks || current.delivery?.control) throw new DomainError('conflict', 'Stopping or cancellation prevents further release mutations. Reconcile the saved operation.');
        if (!releaseAccepted(current) || current.inputHash !== subject.candidate.inputHash || current.delivery?.id !== subject.candidate.runId || current.delivery.review?.candidate.candidateCommit !== subject.candidate.candidateCommit)
          throw new DomainError('conflict', 'The accepted candidate or canonical source changed before the release mutation. Resolve its current hold and evidence first.');
      };
      checkStop();
      if (injected) await injected.authority.authorize(id, digest, mutation);
      else await authorizeDeliveryPolicy(workspace, id, digest);
      checkStop();
    } };
    await authority.authorize(repositoryId, snapshot.configurationDigest);
    if (input.action === 'merge_candidate') await workspace.board.verifyDelivery(input.requestId, before.revision);
    const result = gates.command(input);
    if (result.duplicate || input.action === 'confirm_release_stopped') return result;
    const operationId = input.action === 'reconcile_release' ? input.releaseOperationId : input.operationId;
    const saved = result.request.delivery?.release?.operations.find(value => value.operationId === operationId);
    if (!saved) throw new DomainError('conflict', 'The release operation intent was not retained.');
    const taskId = before.owner.taskId;
    if (!taskId) throw new DomainError('conflict', 'Release requires the retained repository task.');
    const task = workspace.board.executionDetail(taskId);
    if (task.requestId !== before.id || task.repositoryId !== repositoryId) throw new DomainError('conflict', 'The release repository differs from the accepted task.');
    const port = injected?.port ?? createReleaseAdapter({ repository: task.repository, stateDirectory: workspace.config.stateDir, remote: snapshot.configuration.remoteDelivery?.remote,
      authorize: mutation => authority.authorize(repositoryId, snapshot.configurationDigest, mutation) });
    const outcome = await runReleaseOperation({ operation: saved, mode: input.action === 'reconcile_release' ? 'reconcile' : 'execute',
      port, authority, signal: AbortSignal.any([workspace.repositoryStop.signal, AbortSignal.timeout(target.build.timeoutMs + 180000)]) });
    const request = gates.deliveryUpdate(input.requestId, { action: 'release_result', deliveryRunId: saved.candidate.runId, operationId: saved.operationId, result: outcome });
    return { request, duplicate: false };
  });
  running.set(input.requestId, { repositoryId: subject.repositoryId, promise: operation });
  try { return await operation; } finally { if (running.get(input.requestId)?.promise === operation) running.delete(input.requestId); }
}
