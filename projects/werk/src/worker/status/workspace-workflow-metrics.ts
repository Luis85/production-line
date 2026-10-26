import { buildWorkflowMetrics } from '../application/workflow-metrics.js';
import { workflowMetricsWindow } from '../application/workflow-metrics-window.js';
import { deliveryMetricQuery, readDeliveryMetricEvidence } from './workspace-delivery-metric-evidence.js';
import type { WorkspaceContext } from './workspace-context.js';
/** One authenticated read aggregates complete retained evidence, without a submission-date prefilter. */
export function workflowMetrics(workspace: WorkspaceContext, input: unknown) {
  const capturedAt = new Date().toISOString(), query = deliveryMetricQuery(input, 'workflow_metrics', capturedAt);
  workflowMetricsWindow(query, capturedAt);
  return buildWorkflowMetrics(readDeliveryMetricEvidence(workspace, query, capturedAt, false), query, capturedAt);
}
