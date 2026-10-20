import { randomUUID } from 'node:crypto';
import { validateDeliveryPolicySnapshot } from '../../../application/delivery-policy.js';
import { deliveryReadinessView, readinessAssessment, decideReadinessProposal } from '../../../application/delivery-readiness.js';
import type { DeliveryReadinessReference } from '../../../application/delivery-readiness.js';
import type { GateReviewIntent, RequestCommand, WorkerRequest } from '../../../application/request-gates.js';
import type { RequestStore } from './store.js';
import { conflict, invalid, iso } from './values.js';

export function requestReadiness(request: WorkerRequest) {
  const context = request.input.context as { deliveryPolicy?: unknown; readinessReferences?: DeliveryReadinessReference[] } | undefined;
  const snapshot = context?.deliveryPolicy ? validateDeliveryPolicySnapshot(context.deliveryPolicy) : undefined;
  const view = deliveryReadinessView(snapshot?.profile.readiness, request, request.readiness, context?.readinessReferences, snapshot?.baseline);
  if (view.configured) for (const finding of request.findings.filter(item => item.blocking && item.status === 'open' && item.source !== 'deterministic' && request.evaluations.some(evaluation => evaluation.id === item.evaluationId && evaluation.inputRevision === request.inputRevision && evaluation.stage === 'ready'))) {
    view.conditions.push({ id: 'question:' + finding.id, outcome: 'unknown', reason: finding.message }); view.passed = false;
  }
  return view;
}
export function recordReadinessReview(request: WorkerRequest, intent: GateReviewIntent, result: NonNullable<GateReviewIntent['result']>) {
  if (!result.readiness) return;
  if (intent.stage !== 'ready' || !requestReadiness(request).configured) invalid('Structured readiness belongs only to its configured ready gate.');
  request.readiness ??= { assessments: [], decisions: [] };
  if (request.readiness.assessments.length >= 64) conflict('The bounded readiness history is full. Create a linked request.');
  request.readiness.assessments.push(readinessAssessment(result.readiness, request, { kind: 'model', id: intent.id }, intent.id, iso()));
}
export function requestReadinessDecision(store: RequestStore, request: WorkerRequest, command: RequestCommand) {
  if (command.inputRevision !== request.inputRevision || command.inputHash !== request.inputHash || !request.readiness || !requestReadiness(request).configured) conflict('Identify the current request revision and configured readiness assessment.');
  if (['done', 'cancelled', 'review'].includes(request.phase)) conflict('A readiness proposal can only be decided before the current candidate enters review.');
  if (request.readiness.decisions.length >= 128) conflict('The bounded readiness decision history is full.');
  const decision = decideReadinessProposal(request.readiness, request, {
    assessmentId: command.assessmentId!, proposalId: command.proposalId!, outcome: command.decision!,
    reason: command.note!, operationId: command.operationId,
  }, iso());
  request.readiness.decisions.push(decision);
  store.save(request, 'readiness_proposal_' + decision.outcome);
}
export function readinessFindings(request: WorkerRequest, evaluationId: string, view: ReturnType<typeof requestReadiness>) {
  for (const condition of view.conditions.filter(item => item.outcome !== 'pass')) request.findings.push({
    id: randomUUID(), kind: condition.outcome === 'unknown' ? 'gap' : 'question', message: condition.reason,
    blocking: true, source: 'deterministic', evaluationId, ruleId: 'structured-readiness:' + condition.id, status: 'open',
  });
}
