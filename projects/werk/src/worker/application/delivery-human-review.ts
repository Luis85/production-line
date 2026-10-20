import { DomainError } from '../../shared/errors.js';
import { object, text } from '../../shared/contracts.js';
import type { DeliveryHumanOutcome, DeliveryReviewPackage } from './delivery-review-contracts.js';
import type { DeliveryMetricObservation } from './delivery-metrics-contracts.js';

export function humanReviewOutcomes(value: unknown, review: DeliveryReviewPackage, at: string): DeliveryHumanOutcome[] {
  if (!Array.isArray(value) || value.length > 128) throw new DomainError('invalid_input', 'Human review requires bounded individual criterion outcomes.');
  const outcomes = value.map(value => {
    const raw = object(value, 'Human criterion outcome', ['criterionId', 'outcome', 'reason']);
    if (!review.criteria.some(criterion => criterion.id === raw.criterionId && criterion.evaluator === 'human') || typeof raw.outcome !== 'string' || !['passed', 'failed', 'exempted'].includes(raw.outcome)) throw new DomainError('invalid_input', 'Human outcomes must identify a current manual criterion and its observed result.');
    return { criterionId: raw.criterionId as string, outcome: raw.outcome as DeliveryHumanOutcome['outcome'], reason: text(raw.reason, 'Human outcome reason', 4000), actor: 'operator', at };
  });
  if (new Set(outcomes.map(item => item.criterionId)).size !== outcomes.length) throw new DomainError('invalid_input', 'Record each human criterion at most once.');
  return outcomes;
}
export function humanReviewObservations(outcomes: readonly DeliveryHumanOutcome[], candidateDigest: string, minutes?: number): DeliveryMetricObservation[] {
  if (minutes !== undefined && (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0 || minutes > 1440)) throw new DomainError('invalid_input', 'Reported review effort must be between 0 and 1,440 minutes.');
  return [
    ...outcomes.filter(item => item.outcome === 'failed').map(item => ({ kind: 'human_review_failure' as const, candidateDigest, criterionId: item.criterionId })),
    ...(minutes === undefined ? [] : [{ kind: 'review_effort' as const, durationMs: Math.round(minutes * 60000), source: 'user_reported' as const }]),
  ];
}
