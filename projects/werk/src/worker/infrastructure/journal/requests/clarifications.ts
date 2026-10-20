import type { DeliveryMetricObservation } from '../../../application/delivery-metrics-contracts.js';
import type { RequestEvent } from '../../../application/request-gates.js';
import type { RequestStore } from './store.js';

/** Pair explicit operator answers with observed questions; never infer an answer from a source edit. */
export function requestClarificationAnswers(store: RequestStore, requestId: string, questionId: string): DeliveryMetricObservation[] {
  const asked = new Map<string, Extract<DeliveryMetricObservation, { kind: 'clarification' }>>(), answered = new Set<string>();
  for (const row of store.database().prepare('SELECT payload FROM request_events WHERE request_id=? ORDER BY sequence').iterate(requestId)) {
    const event = JSON.parse(String(row.payload)) as RequestEvent;
    for (const observation of event.measurement?.observations ?? []) {
      if (!['clarification', 'clarification_answer'].includes(observation.kind) || !('questionId' in observation) || observation.questionId !== questionId) continue;
      const key = observation.cycleId + ':' + observation.questionId;
      if (observation.kind === 'clarification') asked.set(key, observation);
      else answered.add(key);
    }
  }
  return [...asked].filter(([key]) => !answered.has(key)).map(([, observation]) => ({
    kind: 'clarification_answer', questionId: observation.questionId, cycleId: observation.cycleId, cause: observation.cause,
  }));
}
