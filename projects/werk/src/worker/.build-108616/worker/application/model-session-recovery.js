                                                         
import { requireModelRequest,                   } from './model-contract.js';
import { sessionDigest } from './model-session.js';
/** Only a newly accepted explicit resume can replace an ambiguous provider conversation. */
export function withSessionRecovery(request              , turn                  , prior                  , operationId = turn?.id)               {
  if (request.schemaVersion !== 2 || turn?.kind !== 'resume' || !operationId || !prior?.dispatch || !['failed', 'cancelled', 'interrupted'].includes(prior.status)) return request;
  const next               = { ...request, sessionRecovery: Object.freeze({ operationId, priorTurnId: prior.id, priorDispatchDigest: sessionDigest(prior.dispatch) }) };
  requireModelRequest(next, next.provider.id);
  return Object.freeze(next);
}
