import type { WorkerRequest } from '../application/request-gates';
import type { DeliveryCriterion, DeliveryCriterionResult } from '../application/delivery-review-contracts';
import { deliveryReviewStages } from './delivery-review-stages';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Before packaging, expose only authoritative accepted check IDs against the settled current checkpoint. */
export function deliveryDecisionSubject(request: WorkerRequest) {
  const run = request.delivery;
  if (!run || run.inputRevision !== request.inputRevision || run.inputHash !== request.inputHash || run.policyDigest !== request.policyDigest) return null;
  const review = deliveryReviewStages(request).review;
  if (review) return { candidate: review.candidate, criteria: review.criteria, results: review.results, packaged: true };
  if (!['failed', 'waiting', 'paused', 'interrupted'].includes(run.status)) return null;
  const candidate = run.checkpoints?.at(-1);
  if (!candidate || candidate.requestId !== request.id || candidate.runId !== run.id || candidate.inputRevision !== request.inputRevision || candidate.inputHash !== request.inputHash || candidate.policyDigest !== request.policyDigest) return null;
  const context = request.input.context;
  if (!record(context) || !record(context.implementation) || !Array.isArray(context.implementation.checks)) return null;
  const acceptedChecks = context.implementation.checks;
  const criteria: DeliveryCriterion[] = acceptedChecks.flatMap(check => record(check) && typeof check.id === 'string' && typeof check.name === 'string' ? [{ id: 'check:' + check.id, description: check.name, evaluator: 'check' as const, mandatory: true, checkId: check.id }] : []);
  const evidence = run.steps.findLast(step => step.evidence?.candidateDigest === candidate.candidateDigest)?.evidence;
  const results: DeliveryCriterionResult[] = criteria.map(criterion => { const definition = acceptedChecks.find(item => record(item) && item.id === criterion.checkId); const check = evidence?.checks.find(item => item.presetId === criterion.checkId && item.candidateDigest === candidate.candidateDigest && record(definition) && item.presetFingerprint === definition.fingerprint); return { criterionId: criterion.id, status: check?.status === 'passed' && check.exitCode === 0 ? 'passed' : check?.status === 'failed' ? 'failed' : 'unknown', evidenceRefs: [] }; });
  return { candidate, criteria, results, packaged: false };
}
