import { deliveryReadinessView, type DeliveryReadinessReference } from './delivery-readiness.js';
import { validateDeliveryPolicySnapshot } from './delivery-policy.js';
import type { WorkerRequest } from './request-gates.js';
import type { FeatureRequestReference } from './feature-request-reference.js';
import type { DeliveryPlan } from './delivery-plan.js';
/** Retain accepted intent and supplements separately from the provider's implementation summary. */
export function deliveryRequestDetails(request: WorkerRequest, feature?: FeatureRequestReference, plan?: DeliveryPlan) {
  const context = request.input.context as { deliveryPolicy?: unknown; readinessReferences?: DeliveryReadinessReference[] } | undefined;
  const snapshot = context?.deliveryPolicy ? validateDeliveryPolicySnapshot(context.deliveryPolicy) : undefined;
  const readiness = deliveryReadinessView(snapshot?.profile.readiness, request, request.readiness, context?.readinessReferences, snapshot?.baseline);
  return { requestedOutcome: request.input.message, ...(feature ? { featureId: feature.id, ...(feature.sourcePath ? { sourcePath: feature.sourcePath } : {}) } : {}),
    readinessSupplements: readiness.proposals.filter(item => ['accepted', 'policy_permitted'].includes(item.status)).map(item => ({ id: item.id, kind: item.kind, text: item.text, status: item.status, ...(item.decision ? { reason: item.decision.reason } : {}) })),
    ...(plan ? { plan: structuredClone(plan) } : {}) };
}
