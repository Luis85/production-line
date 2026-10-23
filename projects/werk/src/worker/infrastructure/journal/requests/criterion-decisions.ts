import { deliveryVerificationEligibility } from '../../../application/delivery-verification-eligibility.js';
import { createHash } from 'node:crypto';
import type { DevelopmentScopeView } from '../../../application/development.js';
import type { DeliveryCriterion } from '../../../application/delivery-review-contracts.js';
import { validateDeliveryPolicySnapshot } from '../../../application/delivery-policy.js';
import { recordDeliveryCriterionDecision } from '../../../application/delivery-criterion-decisions.js';
import type { RequestCommand, WorkerRequest } from '../../../application/request-gates.js';
import type { RequestStore } from './store.js';
import { conflict, iso } from './values.js';

export function requestCriterionDecision(store: RequestStore, request: WorkerRequest, input: RequestCommand) {
  const run = request.delivery, candidate = run?.review?.candidate ?? run?.checkpoints?.at(-1);
  if (!run || !candidate || input.deliveryRunId !== run.id || input.inputRevision !== request.inputRevision ||
    input.candidateCommit !== candidate.candidateCommit || input.candidateDigest !== candidate.candidateDigest ||
    candidate.requestId !== request.id || candidate.inputRevision !== request.inputRevision || candidate.inputHash !== request.inputHash ||
    candidate.runId !== run.id || candidate.policyDigest !== request.policyDigest) conflict('A criterion decision must identify the exact current request, run and immutable candidate.');
  if (['done', 'cancelled', 'interrupted'].includes(request.phase) || run.control || run.steps.some(step => ['running', 'outcome_unknown'].includes(step.status)) || ['outcome_unknown', 'reconciling', 'interrupting'].includes(run.status)) conflict('Resolve active or uncertain execution before deciding a criterion exception.');
  const context = request.input.context as { deliveryPolicy?: unknown; implementation?: DevelopmentScopeView } | undefined;
  const policy = context?.deliveryPolicy ? validateDeliveryPolicySnapshot(context.deliveryPolicy).profile.exceptions : undefined;
  const criteria: DeliveryCriterion[] = run.review?.criteria ?? [
    ...(context?.implementation?.checks ?? []).map(check => ({ id: 'check:' + check.id, description: check.name, mandatory: true, evaluator: 'check' as const, checkId: check.id })),
    ...(request.input.criteria ?? []).map((description, index) => ({ id: `human:${index + 1}:${createHash('sha256').update(description).digest('hex').slice(0, 12)}`, description, mandatory: true, evaluator: 'human' as const })),
  ];
  if ((run.criterionDecisions?.length ?? 0) >= 128) conflict('The bounded criterion-decision history is full.');
  const receipt = recordDeliveryCriterionDecision(input.criterionDecision!, { candidate, criteria, policy, operationId: input.operationId, at: iso() });
  run.criterionDecisions = [...(run.criterionDecisions ?? []), receipt];
  const evidence = run.steps.findLast(step => step.phase === 'verifying' && step.evidence?.candidateDigest === candidate.candidateDigest)?.evidence;
  const canContinue = !run.review && !!context?.implementation && deliveryVerificationEligibility(context.implementation, evidence, candidate, run.criterionDecisions, policy).eligible;
  if (canContinue) {
    request.deliveryHolds = (request.deliveryHolds ?? []).filter(hold => hold.code !== 'verification_unavailable');
    run.holds = structuredClone(request.deliveryHolds);
    if (!run.holds.length) { run.status = 'queued'; run.finishedAt = null; request.phase = 'ready'; }
  }
  store.save(request, 'criterion_' + receipt.kind);
}
