import type { WorkflowMetricsReport, WorkflowMetricsQuery, WorkflowWeeklyThroughput, WorkflowEvidenceMetric, WorkflowEbmArea } from '../application/workflow-metrics-contracts';
export type WorkflowWindow = '7d' | '28d' | '90d' | '104w';
export const workflowWindows: { value: WorkflowWindow; label: string }[] = [{ value: '7d', label: 'Last 7 days' }, { value: '28d', label: 'Last 4 weeks' }, { value: '90d', label: 'Last 90 days' }, { value: '104w', label: 'Recent 104 UTC weeks' }];
export function workflowQuery(window: WorkflowWindow, projectId: string, now: number): WorkflowMetricsQuery {
  return { until: new Date(now).toISOString(), ...(window === '104w' ? {} : { since: new Date(now - Number(window.slice(0, -1)) * 86_400_000).toISOString() }), ...(projectId ? { projectId } : {}) };
}
export const workflowNumber = (value: number | null) => value === null ? 'Unmeasured' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
export function workflowDuration(value: number | null): string {
  if (value === null) return 'Unmeasured';
  const [divisor, unit] = value >= 86_400_000 ? [86_400_000, 'days'] : value >= 3_600_000 ? [3_600_000, 'hr'] : value >= 60_000 ? [60_000, 'min'] : value >= 1000 ? [1000, 'sec'] : [1, 'ms'];
  return workflowNumber(value / Number(divisor)) + ' ' + (unit === 'days' && value === Number(divisor) ? 'day' : unit);
}
export const workflowUtcDate = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value));
export const workflowWeekLabel = (start: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(start));
export function visibleWorkflowWeeks(weeks: WorkflowWeeklyThroughput[]): WorkflowWeeklyThroughput[] { return weeks.slice(-12); }
const observationCount = (value: WorkflowEvidenceMetric) => value.observations || value.measuredRequests ? workflowNumber(value.observations) + ' recorded' : 'Unmeasured';
export function workflowMeasures(report: WorkflowMetricsReport) {
  const distribution = (value: WorkflowMetricsReport['timing']['lead']) => `${workflowDuration(value.p50Ms)} / ${workflowDuration(value.p95Ms)}`;
  const coverage = (value: WorkflowMetricsReport['timing']['lead']) => `${value.samples} measured · ${value.unknown} unknown`;
  const observations = (value: WorkflowEvidenceMetric) => `${value.measuredRequests} measured histories · ${value.unknownRequests} unknown`;
  return [
    { id: 'completed', label: 'Throughput · delivered increments', value: workflowNumber(report.throughput.completed), coverage: `${report.coverage.unknownCompletionTimes} unknown completion ${report.coverage.unknownCompletionTimes === 1 ? 'time' : 'times'}`, definition: 'Confirmed integration in the selected completion window. Acceptance and completed model turns do not count as delivery.' },
    { id: 'velocity', label: 'Velocity · complete-week mean', value: report.throughput.meanPerCompleteWeek === null ? 'Unmeasured' : workflowNumber(report.throughput.meanPerCompleteWeek) + ' / week', coverage: `${report.throughput.completeWeeks} whole UTC weeks in window`, definition: 'Delivered increments per complete Monday–Sunday UTC week. Partial edge weeks are excluded from this mean; no story points or forecast are inferred.' },
    { id: 'lead', label: 'Lead time · p50 / p95', value: distribution(report.timing.lead), coverage: coverage(report.timing.lead), definition: 'Eligible submission to confirmed integration. Requests without a known start remain unknown.' },
    { id: 'cycle', label: 'Cycle time · p50 / p95', value: distribution(report.timing.cycle), coverage: coverage(report.timing.cycle), definition: 'First recorded implementation, repair or execution start to confirmed integration.' },
    { id: 'rework', label: 'Rework observations', value: observationCount(report.rework), coverage: observations(report.rework), definition: 'Recorded rework evidence in the selected window. Missing observations do not establish that no rework occurred.' },
    { id: 'failures', label: 'Failure observations', value: observationCount(report.failures), coverage: observations(report.failures), definition: 'Recorded workflow failures, not a customer defect rate or a product-quality score.' },
  ];
}

/** Operational proxies stay attached to their samples; customer and business value are never synthesized. */
export function workflowEbmIndicators(report: WorkflowMetricsReport, area: WorkflowEbmArea['id']) {
  if (area === 'time_to_market') return [
    { label: 'Confirmed output', value: workflowNumber(report.throughput.completed) + ' increments', coverage: 'Selected completion window' },
    { label: 'Lead time · p50', value: workflowDuration(report.timing.lead.p50Ms), coverage: `${report.timing.lead.samples} measured · ${report.timing.lead.unknown} unknown` },
    { label: 'Cycle time · p50', value: workflowDuration(report.timing.cycle.p50Ms), coverage: `${report.timing.cycle.samples} measured · ${report.timing.cycle.unknown} unknown` },
  ];
  if (area === 'ability_to_innovate') return [
    { label: 'Observed work in progress', value: workflowNumber(report.flow.wip) + ' requests', coverage: `${report.flow.blocked} blocked · ${report.flow.unknownState} state unknown` },
    { label: 'Rework observations', value: observationCount(report.rework), coverage: `${report.rework.measuredRequests} measured histories · ${report.rework.unknownRequests} unknown` },
    { label: 'Failure observations', value: observationCount(report.failures), coverage: `${report.failures.measuredRequests} measured histories · ${report.failures.unknownRequests} unknown` },
  ];
  return [];
}
