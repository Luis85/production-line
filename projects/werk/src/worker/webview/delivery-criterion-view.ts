import type { DeliveryReviewPackage } from '../application/delivery-review-contracts';
import { deliveryCriterionDecision, type DeliveryCriterionDecision, type DeliveryCriterionExceptionPolicy } from '../application/delivery-criterion-decisions';
export interface CriterionAuthority { policy?: DeliveryCriterionExceptionPolicy; decisions?: readonly DeliveryCriterionDecision[]; }
export function currentCriterionDecision(review: DeliveryReviewPackage, criterionId: string, authority: CriterionAuthority = {}) {
  try { return deliveryCriterionDecision(criterionId, review.candidate, authority.decisions ?? review.criterionDecisions, authority.policy); } catch { return undefined; }
}
export function criterionObservedPassed(review: DeliveryReviewPackage, criterionId: string) {
  const result = review.results.find(item => item.criterionId === criterionId);
  return (result?.observedStatus ?? result?.status) === 'passed';
}
