import { deliveryLifecycle } from './delivery-behavior.js';
import type { DeliveryBlockerCategory, DeliveryEventMeasurement, DeliveryMetricObservation } from './delivery-metrics-contracts.js';
import type { WorkerRequest } from './request-gates.js';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const categories: Record<string, DeliveryBlockerCategory> = {
  source: 'requirements', readiness: 'requirements', clarification: 'requirements', dependency: 'dependency', dependencies: 'dependency',
  policy_approval: 'permissions', permission: 'permissions', permissions: 'permissions', tool_access: 'permissions',
  consumption: 'budget', budget: 'budget', provider: 'provider', authentication: 'provider',
  provider_authentication_required: 'provider', provider_rate_limited: 'provider', provider_quota_exhausted: 'provider', provider_approval_required: 'permissions',
  verification_unavailable: 'environment', checkpoint_unavailable: 'environment', candidate_review_protocol: 'provider', candidate_review_input: 'requirements',
  environment: 'environment', workspace: 'environment', repository: 'environment', operator: 'operator', paused: 'operator',
};
/** Persist compact facts at the state transition; never infer historic blocker durations from today's state. */
export function deliveryEventMeasurement(request: WorkerRequest, observations?: readonly DeliveryMetricObservation[]): DeliveryEventMeasurement {
  const context = record(request.input.context) ? request.input.context : {};
  const policy = record(context.deliveryPolicy) ? context.deliveryPolicy : {};
  const blockers = new Map<string, DeliveryBlockerCategory>();
  for (const hold of [...(request.deliveryHolds ?? []), ...(request.delivery?.holds ?? [])]) blockers.set(hold.code, categories[hold.code] ?? 'unknown');
  if (request.recoveryHold) blockers.set('recovery', 'unknown');
  for (const finding of request.findings) if (finding.status === 'open' && finding.blocking) {
    const evaluation = request.evaluations.find(item => item.id === finding.evaluationId);
    const fact = evaluation?.rules.find(item => item.ruleId === finding.ruleId)?.fact;
    const category = finding.kind === 'question' || evaluation?.stage === 'ready' && fact?.startsWith('input.') ? 'requirements' : 'unknown';
    blockers.set('finding:' + finding.id, category);
  }
  if (request.phase === 'waiting_input') blockers.set('waiting_input', 'requirements');
  if (request.phase === 'escalated') blockers.set('escalated', 'operator');
  if (request.delivery?.status === 'paused') blockers.set('paused', 'operator');
  if (['done', 'cancelled'].includes(request.phase)) blockers.clear();
  return { projectId: typeof context.repositoryId === 'string' ? context.repositoryId : null,
    profileId: record(policy.profile) && typeof policy.profile.id === 'string' ? policy.profile.id : null,
    lifecycle: deliveryLifecycle(request), ...(request.delivery ? { deliveryStatus: request.delivery.status } : {}),
    blockers: [...blockers].map(([code, category]) => ({ code, category })),
    ...(observations?.length ? { observations: structuredClone([...observations]) } : {}),
  };
}
