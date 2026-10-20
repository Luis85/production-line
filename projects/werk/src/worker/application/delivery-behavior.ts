import type { DeliveryBlackboard, DeliveryCondition, DeliveryControl, DeliveryDecision, DeliveryNode, DeliveryProfile, DeliveryRun } from './delivery-contracts.js';
import type { WorkerRequest } from './request-gate-contracts.js';

/** Authored bounded default profile: lifecycle and authority remain outside this selector. */
export const defaultDeliveryProfile: DeliveryProfile = {
  schemaVersion: 1, id: 'werk-local-delivery', version: 1,
  root: { id: 'delivery', type: 'selector', children: [
    branch('cancel_requested', 'cancel', 'Stop all active execution before closing the request.', 'Confirmed execution stop'),
    branch('unknown_outcome', 'reconcile', 'An interrupted operation needs an observed outcome.', 'Reconciliation or explicit recovery'),
    branch('input_changed', 'wait', 'The accepted request revision changed.', 'Reconciled request revision'),
    branch('held', 'wait', 'A prerequisite needs attention.', 'Resolved prerequisite'),
    branch('paused', 'wait', 'Execution is paused at a step boundary.', 'Explicit resume'),
    branch('active_step', 'observe', 'The current step is already running.', 'Current step result'),
    branch('needs_ready', 'assess', 'Validate the accepted request before dispatch.'),
    branch('needs_plan', 'plan', 'Record the accepted implementation and verification plan.'),
    branch('needs_prepare', 'prepare', 'Verify the isolated workspace and pinned authority.'),
    branch('needs_implementation', 'implement', 'Implement the accepted request.'),
    branch('needs_verification', 'verify', 'Run the required checks for this candidate.'),
    branch('repair_available', 'repair', 'Repair failed checks within the pinned attempt limit.'),
    branch('repair_exhausted', 'wait', 'The bounded repair allowance is exhausted.', 'Operator input or explicit retry'),
    branch('needs_package', 'package', 'Prepare the verified candidate for human review.'),
    branch('reviewable', 'review', 'The candidate is ready for human review.', 'Human review decision'),
  ] },
};
function branch(condition: DeliveryCondition, action: DeliveryDecision['selectedAction'], reason: string, waitingFor?: string): DeliveryNode {
  return { id: condition, type: 'sequence', children: [
    { id: condition + '-condition', type: 'condition', condition },
    { id: condition + '-action', type: 'action', action, reason, ...(waitingFor ? { waitingFor } : {}) },
  ] };
}
export function deliveryBlackboard(request: WorkerRequest): DeliveryBlackboard {
  const run = request.delivery;
  const last = (phase: DeliveryRun['phase']) => run?.steps.findLast(step => step.phase === phase);
  const implementation = run?.steps.findLast(step => ['implementing', 'repairing'].includes(step.phase) && step.turnId === request.execution?.turnId);
  const verification = last('verifying');
  const implementationIndex = implementation ? run!.steps.indexOf(implementation) : -1;
  const verificationCurrent = !!verification && run!.steps.indexOf(verification) > implementationIndex;
  return {
    cancelRequested: run?.control?.action === 'cancel',
    outcomeUnknown: !!run && (['outcome_unknown', 'reconciling', 'interrupting', 'interrupted'].includes(run.status) || run.steps.some(step => step.status === 'outcome_unknown')),
    inputChanged: !!run && (run.inputRevision !== request.inputRevision || run.inputHash !== request.inputHash),
    held: !!run?.holds.length || !!request.recoveryHold || ['waiting_input', 'escalated', 'cancelled', 'done'].includes(request.phase),
    paused: !!run && (run.status === 'paused' || run.control?.action === 'pause_after_step' && !run.steps.some(step => step.status === 'running')),
    activeStep: !!run?.steps.some(step => step.status === 'running'),
    ready: !!request.evaluations.findLast(e => e.stage === 'ready' && e.inputRevision === request.inputRevision)?.passed,
    planned: last('planning')?.status === 'completed', prepared: last('preparing')?.status === 'completed',
    implemented: implementation?.status === 'completed' && implementation.result?.type === 'completed',
    verified: verificationCurrent && verification?.status === 'completed',
    verificationFailed: verificationCurrent && verification?.status === 'failed',
    repairAvailable: !!run && run.repairAttempts < run.maxRepairAttempts,
    packaged: last('packaging')?.status === 'completed',
  };
}
export function evaluateDeliveryBehavior(board: DeliveryBlackboard, profile = defaultDeliveryProfile): DeliveryDecision {
  const conditions: DeliveryDecision['conditions'] = [];
  const facts: Record<DeliveryCondition, boolean> = {
    cancel_requested: board.cancelRequested, unknown_outcome: board.outcomeUnknown, input_changed: board.inputChanged,
    held: board.held, paused: board.paused, active_step: board.activeStep, needs_ready: !board.ready,
    needs_plan: !board.planned, needs_prepare: !board.prepared, needs_implementation: !board.implemented,
    needs_verification: board.implemented && !board.verified && !board.verificationFailed,
    repair_available: board.verificationFailed && board.repairAvailable,
    repair_exhausted: board.verificationFailed && !board.repairAvailable,
    needs_package: board.verified && !board.packaged, reviewable: board.packaged,
  };
  let selected: Extract<DeliveryNode, { type: 'action' }> | undefined;
  let visited = 0;
  function visit(node: DeliveryNode, depth: number): boolean {
    if (++visited > 128 || depth > 8) throw Error('Delivery profile exceeds its bounded tree size.');
    if (node.type === 'condition') {
      const result = facts[node.condition] === true;
      conditions.push({ nodeId: node.id, condition: node.condition, result });
      return result;
    }
    if (node.type === 'action') { selected = node; return true; }
    return node.type === 'selector' ? node.children.some(child => visit(child, depth + 1)) : node.children.every(child => visit(child, depth + 1));
  }
  visit(profile.root, 0);
  return { profileId: profile.id, profileVersion: profile.version, selectedNode: selected?.id ?? 'no-action', selectedAction: selected?.action ?? 'wait', reason: selected?.reason ?? 'No permitted next action.', waitingFor: selected?.waitingFor ?? null, conditions };
}
function deliveryControls(run: DeliveryRun, terminal = false): DeliveryControl[] {
  if (terminal) return ['reopen'];
  if (['outcome_unknown', 'reconciling'].includes(run.status)) return run.control?.action === 'cancel' ? ['confirm_stopped'] : ['confirm_stopped', 'cancel'];
  if (run.control?.action === 'cancel') return [];
  if (run.status === 'interrupting') return ['cancel'];
  if (run.status === 'cancelled') return ['reopen'];
  if (run.status === 'completed') return ['cancel'];
  if (run.status === 'paused') return ['resume', 'cancel'];
  if (run.status === 'interrupted') return ['resume', 'cancel'];
  if (run.status === 'failed') return ['retry', 'cancel'];
  return run.control?.action === 'pause_after_step' ? ['interrupt', 'cancel'] : ['pause_after_step', 'interrupt', 'cancel'];
}
export function refreshDelivery(request: WorkerRequest): void {
  if (!request.delivery) return;
  request.delivery.decision = evaluateDeliveryBehavior(deliveryBlackboard(request), request.delivery.profile);
  request.delivery.allowedControls = deliveryControls(request.delivery, ['cancelled', 'done'].includes(request.phase));
}
export function deliveryLifecycle(request: WorkerRequest): NonNullable<WorkerRequest['lifecycle']> {
  if (request.phase === 'cancelled' || request.phase === 'done') return request.phase;
  if (request.phase === 'review') return 'in_review';
  if (request.delivery?.steps.some(step => ['implementing', 'repairing'].includes(step.phase))) return 'in_progress';
  return request.phase === 'ready' ? 'ready' : 'submitted';
}
