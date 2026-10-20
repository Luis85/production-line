import { currentCriterionDecision, criterionObservedPassed } from './delivery-criterion-view';
import { acceptedDeliveryPolicy } from './delivery-policy-view';
import type { WorkerRequest } from '../application/request-gates';
import { deliveryStatusLabels } from './delivery-view';

type Stage = { state: 'pending' | 'active' | 'complete' | 'blocked' | 'unknown'; detail: string };
/** Current delivery authority outranks retained interaction, patch and gate history. */
export function deliveryReviewStages(request: WorkerRequest) {
  const run = request.delivery!;
  const matches = run.inputRevision === request.inputRevision && run.inputHash === request.inputHash && run.policyDigest === request.policyDigest;
  const candidate = run.review?.candidate;
  const review = matches && run.status === 'completed' && ['in_review', 'done'].includes(request.lifecycle ?? '') && candidate?.requestId === request.id &&
    candidate.runId === run.id && candidate.inputRevision === request.inputRevision && candidate.inputHash === request.inputHash && candidate.policyDigest === request.policyDigest ? run.review! : null;
  const execution: Stage = { state: 'unknown', detail: 'The delivery outcome is not confirmed for the current accepted input.' };
  const verification: Stage = { state: 'unknown', detail: 'No current candidate verification is confirmed. Retained checks remain historical evidence.' };
  const handoff: Stage = { state: 'pending', detail: 'No current delivery review package is confirmed. A retained patch or checkpoint is not a review handoff.' };
  if (!matches) return { execution, verification, handoff, review };
  const state = run.status === 'completed' ? 'complete' : run.status === 'queued' ? 'pending' : ['running', 'pause_pending', 'interrupting'].includes(run.status) ? 'active' : ['outcome_unknown', 'reconciling'].includes(run.status) ? 'unknown' : 'blocked';
  execution.state = state;
  execution.detail = state === 'complete' ? 'This delivery run completed. Verification, human acceptance and merge remain separate.' : deliveryStatusLabels[run.status] + '. ' + run.decision.reason;
  const verificationStep = run.steps.findLast(step => step.phase === 'verifying');
  if (verificationStep?.status === 'running' && ['running', 'pause_pending', 'interrupting'].includes(run.status)) Object.assign(verification, { state: 'active', detail: 'This delivery run is verifying its candidate.' });
  else if (verificationStep?.status === 'failed') Object.assign(verification, { state: 'blocked', detail: 'This delivery run recorded a failed verification step.' });
  if (review) {
    const required = review.criteria.filter(criterion => criterion.mandatory && criterion.evaluator === 'check');
    const authority = { policy: acceptedDeliveryPolicy(request.input.context)?.profile.exceptions, decisions: run.criterionDecisions };
    const observedPassed = required.every(criterion => criterionObservedPassed(review, criterion.id));
    const passed = required.every(criterion => criterionObservedPassed(review, criterion.id) || !!currentCriterionDecision(review, criterion.id, authority));
    Object.assign(verification, { state: passed ? 'complete' : 'blocked', detail: passed ? !observedPassed ? 'Verification eligibility includes disclosed, policy-authorized criterion decisions. Observed failures remain visible in the evidence.' : required.length ? 'Required automated criteria passed for this exact candidate. Human acceptance is separate.' : 'No automated criteria are required for this candidate. Human acceptance is separate.' : 'Required automated criteria have not passed for this exact candidate.' });
    Object.assign(handoff, { state: passed ? 'complete' : 'blocked', detail: passed ? 'The current candidate has a local review package. Human acceptance, remote publication and merge are separate.' : 'The candidate package has unmet automated criteria. A review handoff is not established.' });
  }
  return { execution, verification, handoff, review };
}
