import type { DevelopmentEvidence, DevelopmentScopeView } from './development.js';
import { classifyDevelopmentEvidence } from './development-verification.js';
import type { DeliveryCandidate } from './delivery-review-contracts.js';
import { deliveryCriterionDecision, type DeliveryCriterionDecision, type DeliveryCriterionExceptionPolicy } from './delivery-criterion-decisions.js';

/** Gate eligibility and an observed technical pass are different facts. */
export function deliveryVerificationEligibility(scope: DevelopmentScopeView, evidence: DevelopmentEvidence | undefined,
  candidate?: DeliveryCandidate, decisions: readonly DeliveryCriterionDecision[] = [], policy?: DeliveryCriterionExceptionPolicy) {
  const classification = classifyDevelopmentEvidence(scope, evidence);
  const exact = !!candidate && candidate.baseline === scope.baseCommit && candidate.candidateDigest === classification.candidateDigest;
  const checks = classification.checks.map(check => ({ ...check,
    decision: exact ? deliveryCriterionDecision('check:' + check.id, candidate, decisions, policy) : undefined,
  }));
  return { ...classification, checks, observedVerified: classification.verified,
    eligible: !classification.invalid && !!classification.candidateDigest && classification.changedPaths.length > 0 && checks.length > 0 && checks.every(check => check.passed || !!check.decision) };
}
