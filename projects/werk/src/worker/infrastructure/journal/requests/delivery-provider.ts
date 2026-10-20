import { deliveryVerificationEligibility } from '../../../application/delivery-verification-eligibility.js';
import type { DevelopmentScopeView } from '../../../application/development.js';
import type { DeliveryPolicySnapshot } from '../../../application/delivery-policy.js';
import type { DeliveryUpdate, DeliveryStep } from '../../../application/delivery-contracts.js';
import type { WorkerRequest } from '../../../application/request-gate-contracts.js';
import { validateDeliveryExecutionSnapshot } from '../../../application/delivery-execution-snapshot.js';
import { parseDeliveryAssessment } from '../../../application/delivery-provider-contracts.js';
import { gateDigest } from '../../../application/request-gates.js';
import { clone, conflict, identifier, invalid } from './values.js';
import type { RequestStore } from './store.js';
function execution(request: WorkerRequest) {
  const value = request.input.context as { deliveryExecution?: unknown } | undefined;
  return value?.deliveryExecution ? validateDeliveryExecutionSnapshot(value.deliveryExecution) : undefined;
}
export function validateDeliveryProfileStep(request: WorkerRequest, update: Extract<DeliveryUpdate, { action: 'start' }>): void {
  if (!update.profileId && !update.purpose && !update.handoffId) return;
  const accepted = execution(request), run = request.delivery!;
  const profile = accepted?.profileSnapshots.find(item => item.profileId === update.profileId);
  if (!profile || !update.dispatch || update.dispatch.provider.id !== profile.selection.provider || update.dispatch.provider.model !== profile.selection.model || update.dispatch.provider.effort !== profile.selection.effort || update.dispatch.provider.authenticationMode !== profile.selection.authenticationMode) conflict('The delivery step must use its accepted execution profile.');
  if (update.purpose === 'candidate_review' && (update.phase !== 'verifying' || update.profileId !== accepted!.policy.reviewProfile || update.dispatch.operation !== 'chat' || update.dispatch.toolManifest)) conflict('The candidate reviewer must use its accepted profile without worker tool grants.');
  if (update.handoffId) {
    const receipt = run.handoffs?.find(item => item.id === update.handoffId);
    if (!receipt || receipt.targetProfileId !== update.profileId || receipt.targetInvocationRunId !== update.invocationRunId || receipt.logicalSessionId !== update.dispatch.session?.logicalSessionId || !['implementing', 'repairing'].includes(update.phase)) conflict('The dispatch must match its durable fresh-session handoff.');
  }
}
export function deliveryProviderUpdate(store: RequestStore, request: WorkerRequest, update: Extract<DeliveryUpdate, { action: 'plan' | 'assessment' | 'handoff' }>) {
  const run = request.delivery!;
  if (run.inputRevision !== request.inputRevision || run.inputHash !== request.inputHash || run.policyDigest !== request.policyDigest) conflict('Reconcile changed authority before updating delivery evidence.');
  if (update.action === 'plan') {
    const plan = update.plan, limits = update.effectiveLimits;
    if (plan.schemaVersion !== 1 || plan.requestId !== request.id || plan.inputRevision !== request.inputRevision || plan.inputHash !== request.inputHash || Buffer.byteLength(JSON.stringify(plan)) > 1048576 || !run.steps.some(step => step.phase === 'planning' && step.status === 'running')) conflict('The plan must belong to the active accepted planning step.');
    if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 0) || limits.maxRepairAttempts !== run.maxRepairAttempts) invalid('Invalid frozen delivery execution limits.');
    if (run.plan && (gateDigest(run.plan) !== gateDigest(plan) || gateDigest(run.effectiveLimits) !== gateDigest(limits))) conflict('The accepted delivery plan and limits are immutable.');
    run.plan = clone(plan); run.effectiveLimits = clone(limits);
    store.save(request, 'delivery_plan_recorded'); return request;
  }
  const accepted = execution(request);
  if (!accepted) conflict('This delivery has no accepted execution-profile policy.');
  if (update.action === 'assessment') {
    const assessment = update.assessment, step = run.steps.find(item => item.id === assessment.stepId);
    const candidate = run.checkpoints?.at(-1), verification = run.steps.findLast(item => item.phase === 'verifying' && item.purpose !== 'candidate_review');
    if (step?.purpose !== 'candidate_review' || step.status !== 'completed' || step.result?.type !== 'completed' || step.profileId !== assessment.profileId || step.invocationRunId !== assessment.invocationRunId || assessment.profileId !== accepted.policy.reviewProfile || gateDigest(step.dispatch) !== assessment.dispatchDigest) conflict('Candidate assessment requires the completed accepted reviewer dispatch.');
    const parsed = parseDeliveryAssessment(step.result.text);
    const context = request.input.context as { implementation?: DevelopmentScopeView; deliveryPolicy?: DeliveryPolicySnapshot };
    const eligible = !!context.implementation && deliveryVerificationEligibility(context.implementation, verification?.evidence, candidate, run.criterionDecisions, context.deliveryPolicy?.profile.exceptions).eligible;
    if (!candidate || gateDigest(candidate) !== gateDigest(assessment.candidate) || !eligible || !verification || verification.evidenceDigest !== assessment.evidenceDigest || verification.evidence?.candidateDigest !== candidate.candidateDigest || assessment.passed !== !parsed.findings.some(item => item.severity === 'blocking') || gateDigest(parsed) !== gateDigest({ summary: assessment.summary, findings: assessment.findings })) conflict('Candidate assessment must describe the exact verified checkpoint and actual reviewer findings.');
    if (gateDigest(assessment.selection) !== gateDigest(accepted.profileSnapshots.find(item => item.profileId === assessment.profileId)?.selection)) conflict('Reviewer selection changed.');
    const previous = run.assessments?.find(item => item.stepId === assessment.stepId);
    if (previous) { if (gateDigest(previous) !== gateDigest(assessment)) conflict('A candidate assessment is immutable.'); return request; }
    if ((run.assessments?.length ?? 0) >= 16) conflict('The bounded candidate assessment history is full.');
    run.assessments = [...(run.assessments ?? []), clone(assessment)];
    if (!assessment.passed && run.repairAttempts >= run.maxRepairAttempts) run.status = 'failed';
    store.save(request, 'delivery_candidate_assessed', { deliveryStepId: step.id, runId: assessment.invocationRunId }); return request;
  }
  const receipt = update.handoff;
  for (const id of [receipt.id, receipt.sourceStepId, receipt.sourceInvocationRunId, receipt.targetInvocationRunId, receipt.logicalSessionId]) identifier(id, 'handoff operation identity');
  const source: DeliveryStep | undefined = run.steps.find(item => item.id === receipt.sourceStepId);
  if (receipt.requestId !== request.id || receipt.deliveryRunId !== run.id || receipt.inputRevision !== request.inputRevision || receipt.inputHash !== request.inputHash || receipt.policyDigest !== request.policyDigest || !receipt.freshSession || !/^[a-f0-9]{64}$/.test(receipt.candidateDigest) || !Number.isFinite(Date.parse(receipt.at)) || typeof receipt.summary !== 'string' || receipt.summary.length > 16000) conflict('Handoff must identify the accepted request and retained candidate.');
  const previous = run.handoffs?.find(item => item.id === receipt.id);
  if (previous) { if (gateDigest(previous) !== gateDigest(receipt)) conflict('Handoff authorization is immutable.'); return request; }
  if (run.control || run.holds.length || run.steps.some(item => ['running', 'outcome_unknown'].includes(item.status)) || source?.status !== 'failed' || source.invocationRunId !== receipt.sourceInvocationRunId || !['implementing', 'repairing'].includes(source.phase)) conflict('Observe known provider cessation before authorizing another dispatch.');
  const last = run.handoffs?.at(-1), expectedSource = last?.targetProfileId ?? accepted.resolution.profile.id;
  if (receipt.sourceProfileId !== expectedSource || receipt.targetProfileId === expectedSource || !accepted.policy.fallbackProfiles.includes(receipt.targetProfileId) || !accepted.policy.fallbackOn.includes(receipt.reason) || (run.handoffs?.length ?? 0) >= accepted.policy.maxHandoffs || run.handoffs?.some(item => item.targetProfileId === receipt.targetProfileId || item.logicalSessionId === receipt.logicalSessionId) || run.steps.some(item => item.dispatch?.session?.logicalSessionId === receipt.logicalSessionId)) conflict('The accepted fallback authorization does not permit this transition.');
  if (receipt.checkpointCommit && !run.checkpoints?.some(item => item.candidateCommit === receipt.checkpointCommit && item.candidateDigest === receipt.candidateDigest)) conflict('Handoff checkpoint is not retained by this delivery.');
  run.handoffs = [...(run.handoffs ?? []), clone(receipt)]; run.status = 'queued';
  store.save(request, 'delivery_provider_handoff', { deliveryStepId: source.id, runId: receipt.targetInvocationRunId }); return request;
}
