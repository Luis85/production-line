import type { SharedFeatureView } from '../application/shared-intake-contract';

/** Explain the pre-DoR phase without treating model opinion as gate or execution evidence. */
export function sharedReadyReviewView(request: SharedFeatureView) {
  const review = request.readyReview;
  if (!review) return null;
  if (request.status === 'waiting_ready_input' && request.ready?.passed === false) return {
    label: 'Ready checks need changes', actor: 'operator' as const,
    description: 'The model review finished, but the Definition of Ready checks have not passed. Update the Feature Request, mark it ready, then commit and push. The worker will review the changed request before checking readiness again.',
  };
  if (review.status === 'waiting_input') return {
    label: 'Answers needed', actor: 'operator' as const,
    description: 'Answer the reviewer in the Feature Request’s Answers section and update any unclear requirements. Keep the worker’s findings, mark the request ready, then commit and push. The worker will review the changed request before running the Definition of Ready check.',
  };
  if (review.status === 'failed') return {
    label: 'Review needs attention', actor: 'operator' as const,
    description: 'The review did not finish with a confirmed result. Inspect the recorded error and resolve its cause. Add an explicit retry note to the Feature Request answer area, mark it ready, then commit and push to request another review.',
  };
  if (review.status === 'passed') return {
    label: 'Ready for implementation', actor: 'worker' as const,
    description: 'The request review and Definition of Ready checks have passed. Implementation is waiting for worker capacity and start conditions.',
  };
  return {
    label: review.status === 'running' ? 'Reviewing the request' : 'Waiting for review', actor: 'worker' as const,
    description: review.status === 'running'
      ? 'The reviewer is examining this Feature Request. Findings and questions will be saved in its Markdown note. Implementation has not started.'
      : 'The review is waiting for the worker’s shared execution slot and start conditions. Implementation has not started.',
  };
}
