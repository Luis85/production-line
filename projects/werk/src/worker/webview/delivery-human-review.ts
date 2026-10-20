import type { DeliveryHumanOutcome, DeliveryReviewPackage } from '../application/delivery-review-contracts';

export const humanReviewDraftKey = (review: DeliveryReviewPackage, criterionId: string, field: 'outcome' | 'reason') =>
  `human:${review.candidate.candidateCommit}:${review.candidate.candidateDigest}:${criterionId}:${field}`;
export function deliveryHumanOutcomes(review: DeliveryReviewPackage, read: (key: string) => string): Omit<DeliveryHumanOutcome, 'actor' | 'at'>[] {
  return review.criteria.filter(criterion => criterion.evaluator === 'human').flatMap(criterion => {
    const outcome = read(humanReviewDraftKey(review, criterion.id, 'outcome'));
    const reason = read(humanReviewDraftKey(review, criterion.id, 'reason')).trim();
    return (outcome === 'passed' || outcome === 'failed') && reason
      ? [{ criterionId: criterion.id, outcome, reason }] : [];
  });
}
/** The form cannot turn a checkbox or missing receipt into acceptance evidence. */
export function deliveryHumanReviewReady(review: DeliveryReviewPackage, read: (key: string) => string): boolean {
  const outcomes = deliveryHumanOutcomes(review, read);
  return review.criteria.filter(criterion => criterion.mandatory).every(criterion => criterion.evaluator === 'human'
    ? outcomes.some(outcome => outcome.criterionId === criterion.id && outcome.outcome === 'passed')
    : review.results.some(result => result.criterionId === criterion.id && result.status === 'passed'));
}
