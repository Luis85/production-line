import type { DeliveryMetricsReport, DeliveryMetricDistribution, DeliveryMetricsQuery } from './delivery-metrics-contracts.js';
export type WorkflowMetricsQuery = DeliveryMetricsQuery;
export interface WorkflowMetricsCommand extends DeliveryMetricsQuery { action: 'workflow_metrics'; }
export type WorkflowStageId = 'intake' | 'pre_production' | 'production' | 'post_production' | 'review' | 'merge' | 'build' | 'publish' | 'unknown';
export interface WorkflowStageMetric {
  id: WorkflowStageId; label: string; wip: number; blocked: number; blockedUnknown: number;
  age: DeliveryMetricDistribution; oldestAgeMs: number | null;
}
export interface WorkflowWeeklyThroughput {
  weekStart: string; weekEnd: string; completed: number; partial: boolean;
}
export interface WorkflowEvidenceMetric { requests: number; observations: number; measuredRequests: number; unknownRequests: number; }
export interface WorkflowEbmArea {
  id: 'current_value' | 'unrealized_value' | 'time_to_market' | 'ability_to_innovate';
  label: string; status: 'operational_proxy' | 'unmeasured'; evidence: string[]; unavailable: string[];
}
/** One read model combines current flow, completion-window throughput and explicitly separate submission-cohort quality. */
export interface WorkflowMetricsReport {
  schemaVersion: 1; scope: 'retained_worker_workflow'; capturedAt: string;
  window: { since: string | null; until: string; projectId: string | null; profileId: string | null; basis: 'confirmed_completion_time'; bounds: '[since,until)'; };
  projects: string[]; profiles: string[];
  flow: { asOf: string; basis: 'observation_snapshot_all_submission_dates'; unknownState: number; wip: number; blocked: number; blockedUnknown: number; stages: WorkflowStageMetric[]; };
  throughput: { unit: 'confirmed_increments'; completed: number; weeks: WorkflowWeeklyThroughput[]; completeWeeks: number; meanPerCompleteWeek: number | null; };
  timing: { lead: DeliveryMetricDistribution; cycle: DeliveryMetricDistribution; };
  rework: WorkflowEvidenceMetric; failures: WorkflowEvidenceMetric;
  coverage: { canonicalRequests: number; intakeOnly: number; completeHistories: number; unknownSubmissionTimes: number; closedWithoutIntegration: number; unknownCompletionTimes: number; };
  /** Existing metrics retain their submitted-within cohort and measured denominators. */
  delivery: DeliveryMetricsReport;
  ebm: WorkflowEbmArea[];
  notes: string[];
}
