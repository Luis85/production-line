import { DomainError } from '../../shared/errors.js';
import { object, text } from '../../shared/contracts.js';
import type { DeliveryCandidate, DeliveryCriterion } from './delivery-review-contracts.js';

/** Permission to disclose an exception, never permission to change the observed check result. */
export interface DeliveryCriterionExceptionPolicy {
  exemptibleCriteria: string[];
  notApplicableCriteria: string[];
}
export type DeliveryCriterionDecisionKind = 'exempted' | 'not_applicable';
export interface DeliveryCriterionDecision {
  schemaVersion: 1;
  operationId: string;
  criterionId: string;
  kind: DeliveryCriterionDecisionKind;
  reason: string;
  actor: 'operator';
  at: string;
  subject: Pick<DeliveryCandidate, 'requestId' | 'inputRevision' | 'inputHash' | 'runId' | 'baseline' | 'candidateCommit' | 'candidateDigest' | 'policyDigest' | 'checkDefinitionDigest'>;
}
export type DeliveryCriterionDecisionInput = Pick<DeliveryCriterionDecision, 'criterionId' | 'kind' | 'reason'>;
function invalid(message: string): never { throw new DomainError('invalid_input', message); }
function conflict(message: string): never { throw new DomainError('conflict', message); }
const criterionPattern = /^(?:check:[A-Za-z0-9_-]{1,100}|human:[1-9][0-9]*:[a-f0-9]{12})$/;
const subjectFields = ['requestId', 'inputRevision', 'inputHash', 'runId', 'baseline', 'candidateCommit', 'candidateDigest', 'policyDigest', 'checkDefinitionDigest'] as const;

export function validateDeliveryCriterionExceptionPolicy(value: unknown): DeliveryCriterionExceptionPolicy {
  const raw = object(value, 'Criterion exception policy', ['exemptibleCriteria', 'notApplicableCriteria']);
  const result: DeliveryCriterionExceptionPolicy = { exemptibleCriteria: [], notApplicableCriteria: [] };
  for (const key of ['exemptibleCriteria', 'notApplicableCriteria'] as const) {
    const entries = raw[key];
    if (!Array.isArray(entries) || entries.length > 128 || entries.some(item => typeof item !== 'string' || !criterionPattern.test(item)) || new Set(entries).size !== entries.length)
      invalid('Exception permissions require at most 128 unique exact check or human criterion IDs; wildcards are not permitted.');
    result[key] = [...entries] as string[];
  }
  return result;
}
function validateDeliveryCriterionDecisionInput(value: unknown): DeliveryCriterionDecisionInput {
  const raw = object(value, 'Criterion decision', ['criterionId', 'kind', 'reason']);
  if (typeof raw.criterionId !== 'string' || !criterionPattern.test(raw.criterionId) || typeof raw.kind !== 'string' || !['exempted', 'not_applicable'].includes(raw.kind)) invalid('Use an exact criterion ID and an exempted or not_applicable decision.');
  return { criterionId: raw.criterionId as string, kind: raw.kind as DeliveryCriterionDecisionKind, reason: text(raw.reason, 'Criterion decision reason', 4000) };
}
function subject(candidate: DeliveryCandidate): DeliveryCriterionDecision['subject'] {
  const value = Object.fromEntries(subjectFields.map(key => [key, candidate[key]])) as DeliveryCriterionDecision['subject'];
  if (typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.requestId) || typeof value.runId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.runId) || !Number.isSafeInteger(value.inputRevision) || value.inputRevision < 1 ||
    ['inputHash', 'candidateDigest', 'policyDigest', 'checkDefinitionDigest'].some(key => typeof value[key as keyof typeof value] !== 'string' || !/^[a-f0-9]{64}$/.test(value[key as keyof typeof value] as string)) ||
    ['baseline', 'candidateCommit'].some(key => typeof value[key as keyof typeof value] !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value[key as keyof typeof value] as string))) invalid('A criterion decision requires a complete immutable candidate identity.');
  return value;
}
/** Called only after the application's fresh candidate inspection and guarded operator command. */
export function recordDeliveryCriterionDecision(input: DeliveryCriterionDecisionInput, context: {
  candidate: DeliveryCandidate; criteria: readonly DeliveryCriterion[]; policy?: DeliveryCriterionExceptionPolicy;
  operationId: string; at: string;
}): DeliveryCriterionDecision {
  input = validateDeliveryCriterionDecisionInput(input);
  if (!context.criteria.some(item => item.id === input.criterionId)) conflict('The criterion is not part of the current candidate.');
  if (!context.policy) conflict('The accepted project profile does not permit criterion exceptions.');
  const policy = validateDeliveryCriterionExceptionPolicy(context.policy);
  if (!policy[input.kind === 'exempted' ? 'exemptibleCriteria' : 'notApplicableCriteria'].includes(input.criterionId)) conflict('This decision is not permitted for that exact criterion by the accepted project profile.');
  if (typeof context.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(context.operationId) || typeof context.at !== 'string' || !Number.isFinite(Date.parse(context.at))) invalid('A decision requires a stable command identity and observation timestamp.');
  return { schemaVersion: 1, ...input, operationId: context.operationId, actor: 'operator', at: context.at, subject: subject(context.candidate) };
}
/** Stale, malformed or revoked exceptions never satisfy a current gate. Actual results remain intact. */
export function deliveryCriterionDecision(criterionId: string, candidate: DeliveryCandidate, decisions: readonly DeliveryCriterionDecision[] = [], policy?: DeliveryCriterionExceptionPolicy): DeliveryCriterionDecision | undefined {
  if (!policy) return;
  const expected = subject(candidate), allowed = validateDeliveryCriterionExceptionPolicy(policy);
  return decisions.findLast(decision => decision?.schemaVersion === 1 && decision.criterionId === criterionId && decision.actor === 'operator' &&
    typeof decision.reason === 'string' && !!decision.reason.trim() && decision.reason.length <= 4000 && typeof decision.at === 'string' && Number.isFinite(Date.parse(decision.at)) &&
    typeof decision.operationId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(decision.operationId) && ['exempted', 'not_applicable'].includes(decision.kind) &&
    allowed[decision.kind === 'exempted' ? 'exemptibleCriteria' : 'notApplicableCriteria'].includes(criterionId) &&
    !!decision.subject && subjectFields.every(key => decision.subject[key] === expected[key]));
}
