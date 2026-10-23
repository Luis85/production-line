import { DomainError } from '../../shared/errors.js';
import { assertDeliverySubject } from './delivery-review.js';
import type { LocalTaskRuntime } from './local-task-runtime-contract.js';

/** Re-observe both the retained worktree and immutable review ref before accepting a human command. */
export async function verifyDelivery(host: Pick<LocalTaskRuntime, 'sessions' | 'tasks' | 'running' | 'developmentRuntime' | 'assertToolWorkspace' | 'delivery' | 'workspaceController'>, requestId: string, expectedRevision?: number): Promise<string> {
  const request = host.sessions.requests.get(requestId), review = request.delivery?.review;
  const task = host.tasks.find(item => item.requestId === requestId);
  if (!review || !task?.implementation || !host.delivery || host.running.has(task.id)) throw new DomainError('conflict', 'Wait for a retained, inactive review candidate before recording a review decision.');
  if (expectedRevision !== undefined && request.revision !== expectedRevision) throw new DomainError('conflict', 'The request changed. Refresh before reviewing.');
  const signal = AbortSignal.any([host.workspaceController.signal, AbortSignal.timeout(30000)]);
  const turn = task.currentTurnId ? host.sessions.interactions.turn(task.sessionId, task.currentTurnId) : undefined;
  await host.assertToolWorkspace(task, signal, true, turn?.dispatch?.policy);
  const development = host.developmentRuntime(task, turn?.dispatch?.policy, false);
  if (!development) throw new DomainError('conflict', 'The candidate workspace is unavailable for review verification.');
  const captured = await development.capture(signal);
  assertDeliverySubject(review.candidate, { inputRevision: request.inputRevision, inputHash: request.inputHash, candidateCommit: review.candidate.candidateCommit, candidateDigest: captured.digest, policyDigest: request.policyDigest });
  await host.delivery(task.repository).verify(review.candidate, signal);
  const current = host.sessions.requests.get(requestId);
  if (current.revision !== request.revision || current.delivery?.review?.candidate.candidateCommit !== review.candidate.candidateCommit || host.running.has(task.id)) throw new DomainError('conflict', 'The request changed during verification. Refresh before reviewing.');
  return captured.digest;
}

/** Re-observe a failed or passing checkpoint without requiring a review package. */
export async function verifyDeliveryCheckpoint(host: Pick<LocalTaskRuntime, 'sessions' | 'tasks' | 'running' | 'developmentRuntime' | 'assertToolWorkspace' | 'delivery' | 'workspaceController'>, requestId: string, expectedRevision?: number): Promise<string> {
  const request = host.sessions.requests.get(requestId), run = request.delivery, candidate = run?.checkpoints?.at(-1);
  const task = host.tasks.find(item => item.requestId === requestId);
  const inactive = () => !task || host.running.has(task.id) || !run || ['running', 'interrupting', 'outcome_unknown', 'reconciling'].includes(run.status) || run.steps.some(step => ['running', 'outcome_unknown'].includes(step.status));
  if (!candidate || !task?.implementation || !host.delivery || inactive()) throw new DomainError('conflict', 'Wait for a retained, inactive checkpoint with a known outcome before recording a criterion decision.');
  if (expectedRevision !== undefined && request.revision !== expectedRevision) throw new DomainError('conflict', 'The request changed. Refresh before recording a criterion decision.');
  if (candidate.requestId !== request.id || candidate.runId !== run!.id) throw new DomainError('conflict', 'The checkpoint belongs to a different request or delivery run.');
  const signal = AbortSignal.any([host.workspaceController.signal, AbortSignal.timeout(30000)]);
  const turn = task.currentTurnId ? host.sessions.interactions.turn(task.sessionId, task.currentTurnId) : undefined;
  await host.assertToolWorkspace(task, signal, true, turn?.dispatch?.policy);
  const development = host.developmentRuntime(task, turn?.dispatch?.policy, false);
  if (!development) throw new DomainError('conflict', 'The checkpoint workspace is unavailable for verification.');
  const captured = await development.capture(signal);
  assertDeliverySubject(candidate, { inputRevision: request.inputRevision, inputHash: request.inputHash, candidateCommit: candidate.candidateCommit, candidateDigest: captured.digest, policyDigest: request.policyDigest, baseline: task.implementation.baseCommit });
  await host.delivery(task.repository).verify(candidate, signal);
  const current = host.sessions.requests.get(requestId);
  if (current.revision !== request.revision || current.delivery?.id !== run!.id || current.delivery?.checkpoints?.at(-1)?.candidateCommit !== candidate.candidateCommit || host.running.has(task.id)) throw new DomainError('conflict', 'The checkpoint changed during verification. Refresh before continuing.');
  return captured.digest;
}

/** Verify managed inactivity and record a candidate observation, leaving cessation of orphaned processes to the operator. */
export async function inspectStopped(host: Pick<LocalTaskRuntime, 'sessions' | 'tasks' | 'running' | 'developmentRuntime' | 'assertToolWorkspace' | 'workspaceController' | 'observations'>, requestId: string, expectedRevision?: number) {
  const request = host.sessions.requests.get(requestId), run = request.delivery;
  const task = host.tasks.find(item => item.requestId === requestId);
  if (!run || !task?.implementation || !task.worktree || !task.worktreeIdentity || !['outcome_unknown', 'reconciling'].includes(run.status)) throw new DomainError('conflict', 'Only an unknown delivery with its retained owned worktree can be inspected for recovery.');
  if (expectedRevision !== undefined && request.revision !== expectedRevision) throw new DomainError('conflict', 'The request changed. Refresh before recovery.');
  const assertInactive = async () => {
    const observed = await host.observations?.status();
    if (host.running.has(task.id) || observed?.processes.some(item => item.state === 'running' && (item.taskId === task.id || item.sessionId === task.sessionId))) throw new DomainError('conflict', 'Stop the active managed execution before confirming stopped processes.');
  };
  await assertInactive();
  const signal = AbortSignal.any([host.workspaceController.signal, AbortSignal.timeout(30000)]);
  const turn = task.currentTurnId ? host.sessions.interactions.turn(task.sessionId, task.currentTurnId) : undefined;
  await host.assertToolWorkspace(task, signal, true, turn?.dispatch?.policy);
  const development = host.developmentRuntime(task, turn?.dispatch?.policy, false);
  if (!development) throw new DomainError('conflict', 'The retained candidate cannot be inspected for recovery.');
  const candidate = await development.capture(signal);
  await assertInactive();
  const current = host.sessions.requests.get(requestId);
  if (current.revision !== request.revision || current.delivery?.id !== run.id) throw new DomainError('conflict', 'The request changed during recovery inspection. Refresh before continuing.');
  return { requestRevision: current.revision, deliveryRunId: run.id, inputRevision: current.inputRevision, candidateDigest: candidate.digest, observedAt: new Date().toISOString() };
}


type ReviewMonitor = Pick<LocalTaskRuntime, 'sessions' | 'tasks' | 'running' | 'verifyDelivery' | 'closed' | 'change' | 'evidencePersistenceError'>;
const monitors = new WeakMap<object, { busy: boolean; nextAt: number; inspected: Map<string, number> }>();
/** Bound filesystem reconciliation to one inactive review per second; unchanged candidates append no events. */
export async function reconcileDeliveryReviews(host: ReviewMonitor, now = Date.now()): Promise<void> {
  if (host.closed) return;
  let monitor = monitors.get(host);
  if (!monitor) { monitor = { busy: false, nextAt: 0, inspected: new Map() }; monitors.set(host, monitor); }
  if (monitor.busy || now < monitor.nextAt) return;
  const candidates = host.tasks.flatMap(task => {
    if (!task.requestId || !task.implementation || host.running.has(task.id)) return [];
    const request = host.sessions.requests.get(task.requestId);
    return request.phase === 'review' && request.delivery?.review ? [{ task, request }] : [];
  }).sort((left, right) => (monitor!.inspected.get(left.request.id) ?? 0) - (monitor!.inspected.get(right.request.id) ?? 0));
  const currentIds = new Set(candidates.map(item => item.request.id));
  for (const id of monitor.inspected.keys()) if (!currentIds.has(id)) monitor.inspected.delete(id);
  const selected = candidates[0];
  if (!selected) return;
  const { request, task } = selected;
  monitor.busy = true; monitor.nextAt = now + 1000; monitor.inspected.set(request.id, now);
  try {
    await host.verifyDelivery(request.id, request.revision);
  } catch {
    const current = host.sessions.requests.get(request.id);
    if (host.closed || current.revision !== request.revision || current.phase !== 'review' ||
        current.delivery?.id !== request.delivery?.id || host.running.has(task.id)) return;
    const reason = 'The retained candidate or verification workspace changed or cannot be verified. Inspect its worktree and branch, then Retry to verify a new candidate. Earlier review evidence remains historical.';
    try {
      host.sessions.requests.deliveryUpdate(request.id, { action: 'stale_review', deliveryRunId: current.delivery!.id, reason });
      await host.change(tasks => { const retained = tasks.find(item => item.id === task.id);
        if (retained?.status === 'review') { retained.status = 'needs_rework'; retained.error = reason; }
      });
    } catch { host.evidencePersistenceError = true; }
  } finally { monitor.busy = false; }
}
