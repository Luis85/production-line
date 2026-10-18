import type { InteractionTurn } from './interactions.js';
import { requireModelRequest, type ModelRequest } from './model-contract.js';
import { sessionDigest } from './model-session.js';
/** Only a newly accepted explicit resume can replace an ambiguous provider conversation. */
export function withSessionRecovery(request: ModelRequest, turn?: InteractionTurn, prior?: InteractionTurn, operationId = turn?.id): ModelRequest {
  if (request.schemaVersion !== 2 || turn?.kind !== 'resume' || !operationId || !prior?.dispatch || !['failed', 'cancelled', 'interrupted'].includes(prior.status)) return request;
  const next: ModelRequest = { ...request, sessionRecovery: Object.freeze({ operationId, priorTurnId: prior.id, priorDispatchDigest: sessionDigest(prior.dispatch) }) };
  requireModelRequest(next, next.provider.id);
  return Object.freeze(next);
}
