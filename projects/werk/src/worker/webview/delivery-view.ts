import type { DeliveryControl, DeliveryLifecycle, DeliveryPhase, DeliveryRun, DeliveryStatus } from '../application/delivery-contracts';

export const deliveryLifecycleLabels: Record<DeliveryLifecycle, string> = {
  draft: 'Draft', submitted: 'Submitted', ready: 'Ready', in_progress: 'In progress',
  in_review: 'Ready for human review', done: 'Accepted', cancelled: 'Cancelled',
};
export const deliveryStatusLabels: Record<DeliveryStatus, string> = {
  queued: 'Queued', running: 'Running', waiting: 'Waiting', pause_pending: 'Pause requested',
  paused: 'Paused', interrupting: 'Stopping the active step', interrupted: 'Interrupted',
  reconciling: 'Checking the previous outcome', outcome_unknown: 'Outcome unknown',
  failed: 'Failed', completed: 'Execution complete', cancelled: 'Cancelled',
};
export const deliveryPhaseLabels: Record<DeliveryPhase, string> = {
  assessing: 'Assessing readiness', planning: 'Planning', preparing: 'Preparing the workspace',
  implementing: 'Implementing', verifying: 'Verifying', repairing: 'Repairing', packaging: 'Preparing review',
};
export const deliveryControlLabels: Record<DeliveryControl, string> = {
  pause_after_step: 'Pause after this step', interrupt: 'Interrupt now', cancel: 'Cancel request',
  confirm_stopped: 'Record stopped-process confirmation', resume: 'Resume work', retry: 'Retry failed work', reopen: 'Reopen request',
};
export const deliveryControlHelp: Record<DeliveryControl, string> = {
  pause_after_step: 'Finishes the active step, then waits for your explicit resume command.',
  interrupt: 'Requests an immediate stop. The worker confirms the process outcome before more work can start.',
  cancel: 'Ends this request and retains its evidence. Starting it again requires an explicit reopen.',
  confirm_stopped: 'Records your inspection of the previous processes and the current workspace. This does not resume work; choose Resume work separately after confirmation.',
  resume: 'Continues the saved request from its retained state after the worker checks its eligibility.',
  retry: 'Starts another attempt within the saved request and its configured limits.',
  reopen: 'Reopens this request for another delivery run. Previous evidence remains available.',
};

/** Explains a saved control receipt without inferring that its side effect has finished. */
export function deliveryControlNotice(run: DeliveryRun): string | null {
  if (run.status === 'pause_pending') return 'Pause is recorded. The current step may still be running; work will pause at its next safe boundary.';
  if (run.status === 'interrupting') return 'Interruption is recorded. Waiting for the worker to confirm that the active process has stopped.';
  if (run.status === 'outcome_unknown') return 'The previous process outcome is unknown. Inspect the retained evidence and stop any remaining processes before recording your confirmation; another execution must wait for reconciliation.';
  if (run.status === 'reconciling') return 'The worker is checking whether the previous operation completed before deciding what can safely run next.';
  return null;
}

export function deliveryNextStep(run: DeliveryRun) {
  if (['completed'].includes(run.status)) return null;
  const operator = ['paused', 'interrupted', 'outcome_unknown', 'failed', 'cancelled'].includes(run.status);
  return {
    actor: operator ? 'operator' as const : 'worker' as const,
    title: operator ? deliveryStatusLabels[run.status] : deliveryPhaseLabels[run.phase],
    description: [deliveryControlNotice(run) ?? run.decision.reason, run.decision.waitingFor].filter(Boolean).join(' '),
    ...(operator && run.allowedControls.length ? { action: { kind: 'delivery_controls' as const, label: 'Inspect delivery controls' } } : {}),
  };
}
