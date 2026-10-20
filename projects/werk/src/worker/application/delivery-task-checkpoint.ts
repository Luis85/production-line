import type { DevelopmentRuntime } from './development.js';
import type { LocalTask } from './local-task-contracts.js';
import type { LocalTaskRuntime } from './local-task-runtime-contract.js';

/** Preserve settled source independently of verification; a checkpoint never asserts passing checks. */
export async function retainDeliveryCheckpoint(host: Pick<LocalTaskRuntime, 'sessions' | 'delivery'>, task: LocalTask,
  development: DevelopmentRuntime | undefined, signal: AbortSignal) {
  if (!host.delivery || !development || !task.requestId || !task.implementation) return;
  const request = host.sessions.requests.get(task.requestId), run = request.delivery;
  if (!run || run.steps.some(step => step.status === 'running' || step.status === 'outcome_unknown')) return;
  const captured = await development.capture(signal);
  if (!captured.patch.trim() || !captured.changedPaths.length) return;
  const candidate = await host.delivery(task.repository).checkpoint({ requestId: request.id, inputRevision: request.inputRevision,
    inputHash: request.inputHash, runId: run.id, title: task.title, scope: task.implementation,
    candidate: captured, policyDigest: request.policyDigest }, signal);
  host.sessions.requests.deliveryUpdate(request.id, { action: 'checkpoint', deliveryRunId: run.id, candidate });
  return candidate;
}
