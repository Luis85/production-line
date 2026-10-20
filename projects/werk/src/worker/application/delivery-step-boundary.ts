import { deliveryBlackboard, evaluateDeliveryBehavior } from './delivery-behavior.js';
import type { LocalTask } from './local-task-contracts.js';
import type { LocalTaskRuntime } from './local-task-runtime-contract.js';
import type { DeliveryPhase } from './delivery-contracts.js';
import type { DevelopmentEvidence } from './development.js';
import type { ModelRequest, ModelResult } from './model-contract.js';
import type { ProviderUsage } from './run-evidence.js';
export type DeliveryTaskHost = Pick<LocalTaskRuntime, 'sessions' | 'change' | 'writePatch' | 'validatedPatch' | 'evidencePersistenceError' | 'delivery' | 'model' | 'settings' | 'authorizeDelivery'>;
export class DeliverySuspended extends Error {}
export function taskDelivery(host: Pick<DeliveryTaskHost, 'sessions'>, task: LocalTask) { return task?.requestId ? host.sessions.requests.get(task.requestId).delivery : undefined; }
export function deliveryBoundary(host: Pick<DeliveryTaskHost, 'sessions' | 'authorizeDelivery'>, task: LocalTask): void {
  host.authorizeDelivery?.(task);
  const run = taskDelivery(host, task);
  if (run && (run.control || run.holds.length || ['paused', 'interrupted', 'interrupting', 'outcome_unknown', 'reconciling', 'cancelled'].includes(run.status))) throw new DeliverySuspended('The delivery waits at its persisted step boundary.');
}
export function startDeliveryStep(host: DeliveryTaskHost, task: LocalTask, phase: DeliveryPhase, invocation = task.runId!, dispatch?: ModelRequest, metadata: { purpose?: 'candidate_review'; profileId?: string; handoffId?: string } = {}) {
  deliveryBoundary(host, task);
  const run = taskDelivery(host, task);
  if (!run || !task.requestId) return null;
  const request = host.sessions.requests.get(task.requestId);
  const decision = evaluateDeliveryBehavior(deliveryBlackboard(request), run.profile);
  const permitted = { assessing: 'assess', planning: 'plan', preparing: 'prepare', implementing: 'implement', verifying: metadata.purpose === 'candidate_review' ? 'review_candidate' : 'verify', repairing: 'repair', packaging: 'package' } as const;
  // A durable handoff continues the failed step within its original repair allowance.
  if (!metadata.handoffId && decision.selectedAction !== permitted[phase]) throw new DeliverySuspended(decision.reason);
  const id = invocation + '-' + (metadata.purpose ?? phase) + '-' + run.repairAttempts + (run.recoveries?.length ? '-recovery-' + run.recoveries.length : '');
  host.sessions.requests.deliveryUpdate(task.requestId, { action: 'start', deliveryRunId: run.id, stepId: id, phase, invocationRunId: invocation, turnId: task.currentTurnId, ...(dispatch ? { dispatch } : {}), ...metadata });
  return { id, runId: run.id };
}
export function finishDeliveryStep(host: DeliveryTaskHost, task: LocalTask, step: ReturnType<typeof startDeliveryStep>, status: 'completed' | 'failed', extra: { result?: ModelResult; usage?: ProviderUsage; detail?: string; evidenceDigest?: string; evidence?: DevelopmentEvidence } = {}) {
  if (step && task.requestId) host.sessions.requests.deliveryUpdate(task.requestId, { action: 'finish', deliveryRunId: step.runId, stepId: step.id, status, ...extra });
}
