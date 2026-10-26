import { buildDeliveryMetrics } from '../application/delivery-metrics.js';
import { deliveryMetricQuery, readDeliveryMetricEvidence } from './workspace-delivery-metric-evidence.js';
import type { WorkspaceContext } from './workspace-context.js';

/** Complete retained histories, with explicit refusal instead of silently truncated denominators. */
export function deliveryMetrics(workspace: WorkspaceContext, input: unknown) {
  const capturedAt = new Date().toISOString(), query = deliveryMetricQuery(input, 'metrics', capturedAt);
  return buildDeliveryMetrics(readDeliveryMetricEvidence(workspace, query, capturedAt), query, capturedAt);
}
