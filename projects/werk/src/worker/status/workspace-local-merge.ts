import type { SharedFeatureIntake } from '../application/shared-feature-intake.js';
import { realpath } from 'node:fs/promises';
import { DomainError } from '../../shared/errors.js';
import { localMergeSubject, localMergeView } from '../application/local-merge-view.js';
import { deliveryAccepted } from '../application/delivery-acceptance.js';
import { runLocalMerge } from '../application/local-merge-runtime.js';
import type { LocalMergePort } from '../application/local-merge-contracts.js';
import type { RequestCommand } from '../application/request-gates.js';
import { createLocalMergeGit } from '../infrastructure/local-merge-git.js';
import { authorizeDeliveryPolicy } from './workspace-delivery-policy.js';
import { assertNativeWorkReady } from './workspace-native-work.js';
import type { WorkspaceContext } from './workspace-context.js';

const active = new WeakMap<WorkspaceContext, Map<string, { repositoryId: string; promise: Promise<unknown> }>>();
function operations(workspace: WorkspaceContext) { let value = active.get(workspace); if (!value) { value = new Map(); active.set(workspace, value); } return value; }
export function localMergeActive(workspace: WorkspaceContext, repositoryId: string): boolean { return [...operations(workspace).values()].some(value => value.repositoryId === repositoryId); }
export async function closeLocalMerges(workspace: WorkspaceContext) { await Promise.allSettled([...operations(workspace).values()].map(value => value.promise)); }
async function subject(workspace: WorkspaceContext, requestId: string) {
  const request = workspace.sessions.requests.get(requestId), selected = localMergeSubject(request);
  const assignment = workspace.repositories.resolve(selected.repositoryId), assigned = { ...assignment, path: await realpath(assignment.path) }, task = workspace.board.executionDetail(request.owner.taskId!);
  if (task.requestId !== request.id || task.repositoryId !== selected.repositoryId || task.repository !== assigned.path) throw new DomainError('conflict', 'The accepted task no longer belongs to its assigned main checkout.');
  return { request, ...selected, assigned };
}
export async function requestLocalMergeView(workspace: WorkspaceContext, requestId: string) {
  const request = workspace.sessions.requests.get(requestId); let target = null, reason: string | null = null, busy = operations(workspace).has(requestId);
  try {
    const selected = await subject(workspace, requestId);
    busy ||= [...operations(workspace).values()].some(value => value.repositoryId === selected.repositoryId);
    await authorizeDeliveryPolicy(workspace, selected.repositoryId, selected.snapshot.configurationDigest);
    const git = createLocalMergeGit({ repository: selected.assigned.path, branch: selected.assigned.branch, stateDirectory: workspace.config.stateDir });
    const current = await git.destination(AbortSignal.timeout(30000));
    target = { repositoryId: selected.repositoryId, checkoutPath: current.checkoutPath, branch: current.branch, head: current.head };
    if (!current.clean) reason = 'The main checkout has local, staged or untracked files. Preserve and commit them before approving a merge; reconciliation remains read-only.';
  } catch (error) { reason = error instanceof DomainError ? error.message : 'The assigned main checkout could not be inspected.'; }
  return localMergeView(request, target, reason, busy);
}
/** Explicit checkout approval is a separate command from human acceptance of the candidate. */
export async function mergeLocalRequest(workspace: WorkspaceContext, input: RequestCommand, injected?: { port: LocalMergePort; authorize(mutation: boolean): void | Promise<void> }) {
  assertNativeWorkReady(workspace);
  const selected = await subject(workspace, input.requestId), running = operations(workspace), gates = workspace.sessions.requests;
  if (workspace.repositoryPreparations > 0) throw new DomainError('conflict', 'A repository admission is active. Finish it before approving a main checkout merge.');
  if ([...running.values()].some(value => value.repositoryId === selected.repositoryId)) throw new DomainError('conflict', 'A main checkout merge is active for this project. Wait for its recorded outcome.');
  const promise = Promise.resolve().then(async () => {
    const authorize = async (mutation: boolean) => {
      const check = async () => {
        const current = await subject(workspace, input.requestId);
        if (current.assigned.path !== selected.assigned.path || current.assigned.branch !== selected.assigned.branch || current.repositoryId !== selected.repositoryId || current.snapshot.configurationDigest !== selected.snapshot.configurationDigest) throw new DomainError('conflict', 'The accepted project or main checkout assignment changed.');
        if (mutation && (workspace.repositoryPreparations > 0 || !workspace.acceptingTasks || !deliveryAccepted(current.request) || current.candidate.candidateDigest !== selected.candidate.candidateDigest || current.candidate.candidateCommit !== selected.candidate.candidateCommit || current.candidate.runId !== selected.candidate.runId)) throw new DomainError('conflict', 'The accepted candidate, canonical source or worker availability changed before the main checkout merge.');
      };
      await check(); if (injected) await injected.authorize(mutation); else await authorizeDeliveryPolicy(workspace, selected.repositoryId, selected.snapshot.configurationDigest); await check();
    };
    await authorize(false);
    if (input.action === 'merge_local_candidate') {
      if (input.mainCheckout !== selected.assigned.path || selected.assigned.branch && input.mainBranch !== selected.assigned.branch) throw new DomainError('conflict', 'Merge approval must identify the assigned main checkout and branch.');
      await workspace.board.verifyDelivery(input.requestId, selected.request.revision);
    }
    const result = gates.command(input); if (result.duplicate) return result;
    const operationId = input.action === 'reconcile_local_merge' ? input.localMergeOperationId : input.operationId;
    const saved = result.request.delivery?.localMerge?.operations.find(value => value.operationId === operationId);
    if (!saved || saved.checkoutPath !== selected.assigned.path || selected.assigned.branch && saved.mainBranch !== selected.assigned.branch) throw new DomainError('conflict', 'The retained main checkout merge destination differs from the current assignment.');
    const shared = workspace.featureProjects?.sharedForTask(selected.request.owner.taskId!);
    const intake: SharedFeatureIntake | undefined = shared?.project.sharedRuntime.intake;
    const metadata = intake?.localMergeMetadata(selected.request.owner.taskId!);
    const port = injected?.port ?? createLocalMergeGit({ ...metadata, repository: selected.assigned.path, branch: selected.assigned.branch, stateDirectory: workspace.config.stateDir, authorize });
    const outcome = await runLocalMerge({ operation: saved, mode: input.action === 'reconcile_local_merge' ? 'reconcile' : 'execute', port, authorize,
      signal: AbortSignal.any([workspace.repositoryStop.signal, AbortSignal.timeout(120000)]),
      prepared: preparation => { gates.deliveryUpdate(input.requestId, { action: 'local_merge_prepared', deliveryRunId: saved.candidate.runId, operationId: saved.operationId, preparation }); } });
    const request = gates.deliveryUpdate(input.requestId, { action: 'local_merge_result', deliveryRunId: saved.candidate.runId, operationId: saved.operationId, result: outcome });
    return { request, duplicate: false };
  });
  running.set(input.requestId, { repositoryId: selected.repositoryId, promise });
  try { return await promise; } finally { if (running.get(input.requestId)?.promise === promise) running.delete(input.requestId); }
}
