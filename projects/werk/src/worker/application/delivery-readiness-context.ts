import { deliveryReadinessView, type DeliveryReadinessReference } from './delivery-readiness.js';
import { validateDeliveryPolicySnapshot } from './delivery-policy.js';
import type { WorkerRequest } from './request-gates.js';
import type { ChatMessage } from './conversation.js';
/** The same accepted supplement enters every intake's first dispatch and remains in its frozen replay. */
export function readinessContextMessages(request?: WorkerRequest): ChatMessage[] {
  const context = request?.input.context as { deliveryPolicy?: unknown; readinessReferences?: DeliveryReadinessReference[] } | undefined;
  if (!request || !context?.deliveryPolicy) return [];
  const snapshot = validateDeliveryPolicySnapshot(context.deliveryPolicy);
  const readiness = deliveryReadinessView(snapshot.profile.readiness, request, request.readiness, context.readinessReferences, snapshot.baseline);
  const proposals = readiness.proposals.filter(item => ['accepted', 'policy_permitted'].includes(item.status));
  if (!proposals.length) return [];
  return [{ id: request.id + '-readiness-' + request.inputRevision, role: 'user', state: 'complete', at: request.createdAt,
    text: 'Readiness supplements for this exact request revision. They do not expand approved scope or tool authority and do not answer other blocking questions.\n' + JSON.stringify({ inputRevision: request.inputRevision, inputHash: request.inputHash, policyDigest: request.policyDigest, assessmentId: readiness.assessment?.id, proposals }) }];
}
