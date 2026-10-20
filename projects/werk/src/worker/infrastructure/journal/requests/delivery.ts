import type { DeliveryMetricObservation } from '../../../application/delivery-metrics-contracts.js';
import { selectedDeliveryBehavior } from '../../../application/delivery-behavior-policy.js';
import { deliveryProviderUpdate, validateDeliveryProfileStep } from './delivery-provider.js';
import { remotePublicationPending } from '../../../application/remote-delivery-contracts.js';
import { requestPublicationResult } from './publication.js';
import { validateDeliveryPolicySnapshot } from '../../../application/delivery-policy.js';
import { randomUUID } from 'node:crypto';
import type { DeliveryRun, DeliveryStopObservation, DeliveryUpdate } from '../../../application/delivery-contracts.js';
import { refreshDelivery } from '../../../application/delivery-behavior.js';
import { gateDigest, type GateInput, type RequestCommand, type WorkerRequest } from '../../../application/request-gates.js';
import type { RequestStore } from './store.js';
import { clone, conflict, identifier, invalid, iso, requestCandidate } from './values.js';

export function ensureDelivery(request: WorkerRequest): DeliveryRun {
  if (request.delivery?.inputRevision === request.inputRevision) return request.delivery;
  const context = request.input.context;
  const acceptedPolicy = context && typeof context === 'object' && 'deliveryPolicy' in context ? validateDeliveryPolicySnapshot(context.deliveryPolicy) : undefined;
  const profile = selectedDeliveryBehavior(acceptedPolicy?.configuration.behaviors);
  const run: DeliveryRun = {
    schemaVersion: 1, id: randomUUID(), inputRevision: request.inputRevision, inputHash: request.inputHash, policyDigest: request.policyDigest,
    profile, profileDigest: gateDigest(profile), status: 'queued', phase: 'preparing', control: null,
    holds: clone(request.deliveryHolds ?? []), repairAttempts: 0, maxRepairAttempts: acceptedPolicy?.profile.maxRepairAttempts ?? request.policy.rework.maxAttempts,
    startedAt: iso(), finishedAt: null, steps: [], allowedControls: [],
    decision: { profileId: profile.id, profileVersion: profile.version, selectedNode: 'initial', selectedAction: 'prepare', reason: 'Prepare the accepted request.', waitingFor: null, conditions: [] },
  };
  request.delivery = run;
  refreshDelivery(request);
  return run;
}
export function requestDeliveryUpdate(store: RequestStore, id: string, update: DeliveryUpdate) {
  return store.transaction(() => {
    const request = store.get(id);
    if (update.action === 'hold' || update.action === 'clear_hold') {
      if (!/^[a-z][a-z0-9_-]{0,79}$/.test(update.code)) invalid('Use a bounded hold reason code.');
      const holds = (request.delivery?.holds ?? request.deliveryHolds ?? []).filter(item => item.code !== update.code);
      if (update.action === 'hold') {
        if (!update.reason?.trim() || update.reason.length > 4000) invalid('A delivery hold requires a bounded explanation.');
        holds.push({ code: update.code, reason: update.reason });
      }
      if (gateDigest(holds) === gateDigest(request.deliveryHolds ?? [])) return request;
      request.deliveryHolds = holds;
      if (request.delivery) request.delivery.holds = clone(holds);
      store.save(request, update.action === 'hold' ? 'delivery_held' : 'delivery_hold_cleared');
      return request;
    }
    const run = request.delivery;
    if (!run || run.id !== update.deliveryRunId) conflict('The delivery run changed. Refresh its current identity.');
    if (update.action === 'publication_result') return requestPublicationResult(store, request, update);
    if (update.action === 'plan' || update.action === 'assessment' || update.action === 'handoff') return deliveryProviderUpdate(store, request, update as Extract<DeliveryUpdate, { action: 'plan' | 'assessment' | 'handoff' }>);
    if (update.action === 'checkpoint') {
      const candidate = update.candidate;
      if (candidate.requestId !== request.id || candidate.runId !== run.id || candidate.inputRevision !== request.inputRevision || candidate.inputHash !== request.inputHash || candidate.policyDigest !== request.policyDigest) conflict('The checkpoint does not match the accepted delivery.');
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(candidate.candidateCommit) || !/^[a-f0-9]{64}$/.test(candidate.candidateDigest)) invalid('A checkpoint requires a known Git commit and candidate digest.');
      const previous = run.checkpoints?.find(item => item.candidateCommit === candidate.candidateCommit);
      if (previous) {
        if (gateDigest(previous) !== gateDigest(candidate)) conflict('A checkpoint commit already has different recorded evidence.');
        return request;
      }
      if ((run.checkpoints?.length ?? 0) >= 64) conflict('The bounded delivery checkpoint history is full.');
      run.checkpoints = [...(run.checkpoints ?? []), clone(candidate)];
      store.save(request, 'delivery_checkpoint_retained'); return request;
    }
    if (update.action === 'stale_review') {
      if (!run.review || request.phase !== 'review') conflict('Only the current review candidate can become stale.');
      if (!update.reason?.trim() || update.reason.length > 4000) invalid('A stale review requires a bounded explanation.');
      const hold = { code: 'candidate_changed', reason: update.reason.trim() };
      request.deliveryHolds = [...(request.deliveryHolds ?? []).filter(item => item.code !== hold.code), hold];
      run.holds = clone(request.deliveryHolds); run.status = 'failed'; run.finishedAt = null;
      request.phase = 'needs_rework'; request.attestation = null;
      store.save(request, 'delivery_review_stale'); return request;
    }
    if (update.action === 'review') {
      if (update.review.candidate.requestId !== request.id || update.review.candidate.runId !== run.id || update.review.candidate.inputRevision !== request.inputRevision || update.review.candidate.inputHash !== request.inputHash || update.review.candidate.policyDigest !== request.policyDigest) conflict('Review package does not match the accepted delivery.');
      if (run.review && gateDigest(run.review) !== gateDigest(update.review)) conflict('A delivery review package is immutable.');
      run.review = clone(update.review); store.save(request, 'delivery_review_packaged'); return request;
    }
    if (update.action === 'stopped') {
      const active = run.steps.filter(step => step.status === 'running' || step.status === 'outcome_unknown');
      const observations: DeliveryMetricObservation[] = !update.confirmed || active.some(step => step.status === 'outcome_unknown') || run.control && ['interrupt', 'cancel'].includes(run.control.action)
        ? [{ kind: 'recovery', operationId: run.control?.operationId ?? run.id + ':' + (active[0]?.id ?? 'stop'), outcome: update.confirmed ? 'known' : 'unknown', duplicateActions: null }] : [];
      for (const step of active) { step.status = update.confirmed ? update.failure && (!run.control || run.control.action === 'pause_after_step') ? 'failed' : 'interrupted' : 'outcome_unknown'; step.finishedAt = update.confirmed ? iso() : null; step.detail = update.detail ?? null; }
      run.status = !update.confirmed ? 'outcome_unknown' : run.control?.action === 'cancel' ? 'cancelled' : update.failure && (!run.control || run.control.action === 'pause_after_step') ? 'failed' : 'interrupted';
      if (run.status === 'cancelled') { request.phase = 'cancelled'; run.finishedAt = iso(); }
      store.save(request, update.confirmed ? 'delivery_stopped' : 'delivery_stop_unknown', { ...(active.length === 1 ? { deliveryStepId: active[0]!.id } : {}), observations });
      return request;
    }
    identifier(update.stepId, 'delivery step ID');
    const previous = run.steps.find(step => step.id === update.stepId);
    if (update.action === 'start') {
      validateDeliveryProfileStep(request, update);
      if (previous) {
        if (previous.phase !== update.phase || previous.turnId !== (update.turnId ?? null) || previous.invocationRunId !== (update.invocationRunId ?? null) || previous.purpose !== update.purpose || previous.handoffId !== update.handoffId || gateDigest(previous.dispatch ?? null) !== gateDigest(update.dispatch ?? null)) conflict('A delivery step ID already belongs to another operation.');
        return request;
      }
      if (run.inputRevision !== request.inputRevision || run.inputHash !== request.inputHash || run.policyDigest !== request.policyDigest) conflict('Reconcile changed request inputs before starting another step.');
      if (run.control || run.holds.length || request.recoveryHold || ['paused', 'interrupting', 'interrupted', 'outcome_unknown', 'reconciling', 'cancelled', 'completed'].includes(run.status)) conflict('Delivery is held. Resolve its control or prerequisite before starting another step.');
      if (run.steps.some(step => ['running', 'outcome_unknown'].includes(step.status))) conflict('Observe the existing step before starting another operation.');
      if (run.steps.length >= 64) conflict('The bounded delivery step history is full.');
      if (update.phase === 'repairing' && !update.handoffId) {
        if (run.repairAttempts >= run.maxRepairAttempts) conflict('The pinned repair allowance is exhausted.');
        run.repairAttempts++;
      }
      run.phase = update.phase; run.status = 'running';
      run.steps.push({ id: update.stepId, phase: update.phase, status: 'running', turnId: update.turnId ?? null, invocationRunId: update.invocationRunId ?? null, startedAt: iso(), finishedAt: null, detail: null, ...(update.purpose ? { purpose: update.purpose } : {}), ...(update.profileId ? { profileId: update.profileId } : {}), ...(update.handoffId ? { handoffId: update.handoffId } : {}), ...(update.dispatch ? { dispatch: clone(update.dispatch) } : {}) });
      store.save(request, 'delivery_step_started', { turnId: update.turnId, runId: update.invocationRunId, deliveryStepId: update.stepId });
      return request;
    }
    if (!previous) conflict('A delivery result requires its persisted start intent.');
    if (previous.status !== 'running') {
      if (previous.status !== update.status || gateDigest(previous.result ?? null) !== gateDigest(update.result ?? null)) conflict('A known delivery step result is immutable.');
      return request;
    }
    if (update.result && Buffer.byteLength(JSON.stringify(update.result)) > 1048576) invalid('Delivery checkpoint exceeds its bounded size.');
    Object.assign(previous, { status: update.status, finishedAt: iso(), detail: update.detail ?? null,
      ...(update.result ? { result: clone(update.result) } : {}), ...(update.usage ? { usage: clone(update.usage) } : {}),
      ...(update.evidenceDigest ? { evidenceDigest: update.evidenceDigest } : {}), ...(update.evidence ? { evidence: clone(update.evidence) } : {}) });
    run.status = update.status === 'outcome_unknown' ? 'outcome_unknown' : update.status === 'interrupted' ? 'interrupted' : run.control?.action === 'pause_after_step' ? 'paused' : run.control ? 'interrupting' : update.result?.type === 'needs_input' ? 'waiting' : update.status === 'failed' && (previous.phase !== 'verifying' || run.repairAttempts >= run.maxRepairAttempts) ? 'failed' : 'queued';
    if (previous.phase === 'verifying' && update.evidence?.checks.some(check => check.status === 'interrupted' || check.exitCode === null)) run.status = 'failed';
    if (previous.phase === 'packaging' && update.status === 'completed' && !run.control) { run.status = 'completed'; run.finishedAt = iso(); }
    store.save(request, 'delivery_step_' + update.status, { turnId: previous.turnId ?? undefined, runId: previous.invocationRunId ?? undefined, deliveryStepId: previous.id });
    return request;
  });
}
export const deliveryCommandActions = ['pause_after_step', 'interrupt', 'resume', 'retry', 'reopen', 'confirm_stopped'] as const;
export function requestDeliveryCommand(store: RequestStore, request: WorkerRequest, input: RequestCommand, stopped?: DeliveryStopObservation): void {
  const run = request.delivery;
  if (!run || input.deliveryRunId !== run.id || input.inputRevision !== request.inputRevision) conflict('Control must identify the current delivery run and request input revision.');
  refreshDelivery(request);
  if (!run.allowedControls.includes(input.action as typeof run.allowedControls[number])) conflict('This control is not available for the current delivery state.');
  const active = remotePublicationPending(run) || run.steps.some(step => step.status === 'running' || step.status === 'outcome_unknown');
  const recoveryStep = run.steps.findLast(step => step.status === 'outcome_unknown')?.id;
  if (input.action === 'pause_after_step' || input.action === 'interrupt' || input.action === 'cancel') {
    run.control = { action: input.action, operationId: input.operationId, at: iso() };
    run.status = input.action === 'pause_after_step' ? active ? 'pause_pending' : 'paused' : active ? 'interrupting' : input.action === 'cancel' ? 'cancelled' : 'interrupted';
    if (run.status === 'cancelled') { request.phase = 'cancelled'; run.finishedAt = iso(); }
  } else if (input.action === 'confirm_stopped') {
    if (!input.note?.trim()) invalid('Confirming stopped processes requires an operator inspection note.');
    if (!stopped || stopped.requestRevision !== request.revision || stopped.deliveryRunId !== run.id || stopped.inputRevision !== request.inputRevision || !/^[a-f0-9]{64}$/.test(stopped.candidateDigest) || !Number.isFinite(Date.parse(stopped.observedAt))) conflict('Inspect the inactive owned worktree before confirming stopped processes.');
    if (run.steps.some(step => step.status === 'running')) conflict('The current step is still active; wait for its observed outcome.');
    if ((run.recoveries?.length ?? 0) >= 16) conflict('The bounded recovery history is full. Start an explicit successor request.');
    run.recoveries = [...(run.recoveries ?? []), { source: 'operator_attestation', operationId: input.operationId, note: input.note.trim(), at: stopped.observedAt, candidateDigest: stopped.candidateDigest }];
    for (const step of run.steps) if (step.status === 'outcome_unknown') {
      step.status = 'interrupted'; step.finishedAt = stopped.observedAt;
      step.detail = 'The operator attested that prior processes were inspected and stopped. Their unrecorded outcome remains unknown.';
    }
    run.status = run.control?.action === 'cancel' ? 'cancelled' : 'interrupted';
    if (request.execution && ['prepared', 'running'].includes(request.execution.status)) { request.execution.status = 'interrupted'; request.execution.outcome = 'interrupted'; }
    request.phase = run.status === 'cancelled' ? 'cancelled' : 'interrupted';
    if (run.status === 'cancelled') run.finishedAt = stopped.observedAt;
  } else if (input.action === 'reopen') {
    if (!['cancelled', 'done'].includes(request.phase)) conflict('Only closed deliveries can be explicitly reopened.');
    request.phase = 'readiness'; request.execution = null; request.attestation = null; request.inputRevision++; store.generation(request);
    request.deliveryHistory = [...(request.deliveryHistory ?? []), clone(run)].slice(-16);
    delete request.delivery;
    ensureDelivery(request);
  } else if (input.action === 'retry') {
    if (active) conflict('Confirm that the failed operation stopped before retrying.');
    request.deliveryHistory = [...(request.deliveryHistory ?? []), clone(run)].slice(-16);
    delete request.delivery; request.deliveryHolds = (request.deliveryHolds ?? []).filter(hold => !['provider_authentication_required', 'provider_rate_limited', 'provider_quota_exhausted', 'provider_approval_required', 'verification_unavailable', 'candidate_changed', 'checkpoint_unavailable', 'candidate_review_input', 'candidate_review_protocol'].includes(hold.code));
    request.execution = null; request.attestation = null; request.phase = 'ready';
    ensureDelivery(request);
  } else {
    if (active) conflict('Confirm that the interrupted operation stopped before resuming.');
    run.control = null; run.status = 'queued'; run.finishedAt = null;
    if (['failed', 'interrupted'].includes(request.phase)) request.phase = 'ready';
  }
  store.save(request, 'delivery_' + input.action, input.action === 'confirm_stopped' ? { deliveryStepId: recoveryStep, observations: [{ kind: 'recovery', operationId: run.control?.operationId ?? run.id + ':' + (recoveryStep ?? 'stop'), outcome: 'unknown', duplicateActions: null }] } : {});
}
export function requestReviseInput(store: RequestStore, id: string, input: GateInput): WorkerRequest {
  return store.transaction(() => {
    const request = store.get(id);
    if (remotePublicationPending(request.delivery)) conflict('Reconcile the saved remote publication before accepting a changed request revision.');
    if (request.execution && ['running', 'prepared'].includes(request.execution.status) || request.delivery?.steps.some(step => ['running', 'outcome_unknown'].includes(step.status))) conflict('Stop the active operation before accepting a changed request revision.');
    if (['done', 'cancelled'].includes(request.phase)) conflict('Reopen the request explicitly before accepting a revision.');
    requestCandidate(request, input, 'operator');
    const candidate = request.candidates.at(-1)!;
    if (candidate.inputHash === request.inputHash) return request;
    candidate.status = 'accepted';
    request.input = clone(candidate.input); request.inputHash = candidate.inputHash; request.inputRevision++;
    if (request.delivery) request.deliveryHistory = [...(request.deliveryHistory ?? []), clone(request.delivery)].slice(-16);
    delete request.delivery; request.deliveryHolds = (request.deliveryHolds ?? []).filter(hold => hold.code !== 'review_changes'); request.execution = null; request.attestation = null; request.phase = 'readiness';
    store.generation(request); store.save(request, 'source_revision_accepted');
    return request;
  });
}
