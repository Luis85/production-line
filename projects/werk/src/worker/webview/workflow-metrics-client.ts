import type { WorkflowMetricsQuery, WorkflowMetricsReport, WorkflowMetricsCommand } from '../application/workflow-metrics-contracts';
import { request } from './store';
/** The read endpoint owns cohort selection, observed completion times and all measured denominators. */
export function readWorkflowMetrics(query: WorkflowMetricsQuery = {}): Promise<WorkflowMetricsReport> {
  const command: WorkflowMetricsCommand = { ...query, action: 'workflow_metrics' };
  return request<WorkflowMetricsReport>('/api/requests', 'POST', command);
}
