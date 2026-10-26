import { buildDeliveryMetrics } from './delivery-metrics.js';
import type { DeliveryMetricsInput } from './delivery-metrics-contracts.js';
import type { WorkflowMetricsQuery, WorkflowMetricsReport, WorkflowStageId, WorkflowEbmArea } from './workflow-metrics-contracts.js';
import { workflowMetricsWindow, workflowWeekMs, workflowWeekStart } from './workflow-metrics-window.js';
import { workflowObservations, workflowCompletion, workflowCycleStart, workflowDistribution, workflowSnapshot, workflowEvidenceCounts } from './workflow-metric-evidence.js';
const labels: [WorkflowStageId, string][] = [['intake', 'Intake'], ['pre_production', 'Pre-production'], ['production', 'Production'], ['post_production', 'Post-production'], ['review', 'Review'], ['merge', 'Merge'], ['build', 'Build'], ['publish', 'Publish'], ['unknown', 'Unclassified active work']];
const ebm: WorkflowEbmArea[] = [
  { id: 'current_value', label: 'Current value', status: 'unmeasured', evidence: [], unavailable: ['Customer outcomes, satisfaction, revenue and realized business value are not recorded.'] },
  { id: 'unrealized_value', label: 'Unrealized value', status: 'unmeasured', evidence: [], unavailable: ['Unmet customer needs, market opportunities and expected value are not recorded.'] },
  { id: 'time_to_market', label: 'Time to market', status: 'operational_proxy', evidence: ['Confirmed integrations per UTC week', 'Observed submission-to-integration and implementation-to-integration time'], unavailable: ['Integration is not evidence of customer deployment or value realization.'] },
  { id: 'ability_to_innovate', label: 'Ability to innovate', status: 'operational_proxy', evidence: ['Observed work in progress and blocker ages', 'Recorded repair, review-change and failure observations'], unavailable: ['Innovation investment, workforce capacity and product innovation outcomes are not recorded.'] },
];
/** Operational output is measured from retained authority; business outcomes are never inferred from activity. */
export function buildWorkflowMetrics(input: DeliveryMetricsInput, query: WorkflowMetricsQuery = {}, capturedAt = new Date().toISOString()): WorkflowMetricsReport {
  const window = workflowMetricsWindow(query, capturedAt), rows = workflowObservations(input, query, window.until);
  const weeks: WorkflowMetricsReport['throughput']['weeks'] = [];
  if (window.since < window.until) for (let at = workflowWeekStart(window.since); at < window.until; at += workflowWeekMs)
    weeks.push({ weekStart: new Date(at).toISOString(), weekEnd: new Date(at + workflowWeekMs).toISOString(), completed: 0, partial: at < window.since || at + workflowWeekMs > window.until });
  const stages = labels.map(([id, label]) => ({ id, label, wip: 0, blocked: 0, blockedUnknown: 0, age: workflowDistribution([]), oldestAgeMs: null as number | null }));
  const ages = new Map<WorkflowStageId, (number | null)[]>(stages.map(stage => [stage.id, []]));
  const report: WorkflowMetricsReport = {
    schemaVersion: 1, scope: 'retained_worker_workflow', capturedAt,
    window: { since: window.query.since, until: window.query.until, projectId: query.projectId ?? null, profileId: query.profileId ?? null, basis: 'confirmed_completion_time', bounds: '[since,until)' },
    projects: [], profiles: [], flow: { asOf: window.query.until, basis: 'observation_snapshot_all_submission_dates', unknownState: 0, wip: 0, blocked: 0, blockedUnknown: 0, stages },
    throughput: { unit: 'confirmed_increments', completed: 0, weeks, completeWeeks: weeks.filter(week => !week.partial).length, meanPerCompleteWeek: null }, timing: { lead: workflowDistribution([]), cycle: workflowDistribution([]) },
    rework: { requests: 0, observations: 0, measuredRequests: 0, unknownRequests: 0 }, failures: { requests: 0, observations: 0, measuredRequests: 0, unknownRequests: 0 },
    coverage: { canonicalRequests: rows.filter(row => row.request).length, intakeOnly: rows.filter(row => !row.request).length, completeHistories: rows.filter(row => row.complete).length, unknownSubmissionTimes: rows.filter(row => row.submittedAt === null).length, closedWithoutIntegration: 0, unknownCompletionTimes: 0 },
    delivery: buildDeliveryMetrics(input, window.query, capturedAt), ebm: structuredClone(ebm),
    notes: ['Throughput counts each retained canonical request once, only after a confirmed main-checkout merge or its required release publication. Acceptance, a Markdown handoff and model attempts are not delivered increments.',
      'Completion and observation counts use [since, until); the WIP snapshot includes observations at or before until, across all submission dates. Future mutable state is not used to reconstruct historical work.',
      'Complete UTC weeks describe window coverage, not proof that retained history is exhaustive.',
      'UTC weeks begin Monday. Boundary weeks are partial and excluded from the mean per complete week. Without since, the bounded default contains the latest 104 UTC weeks.',
      'Lead time begins at the observed eligible submission, or journal admission when no intake record exists. Cycle time begins at the first recorded implementation/repair step or execution-start event. Missing or negative anchors remain unknown.',
      'Rework counts explicit review-change events and distinct repair-step starts. Failures count recorded failed execution/review/step observations; retries and successful attempts do not establish zero defects.',
      'The embedded delivery report uses a separate submitted-within cohort. Rates, sample counts and unknown coverage retain their original definitions. These operational proxies do not measure customer value or individual productivity.'],
  };
  const all = workflowObservations(input, {}, window.until);
  report.projects = [...new Set(input.availableProjects ?? all.flatMap(row => row.projectId ? [row.projectId] : []))].sort(); report.profiles = [...new Set(input.availableProfiles ?? all.flatMap(row => row.profileId ? [row.profileId] : []))].sort();
  const lead: (number | null)[] = [], cycle: (number | null)[] = [];
  for (const row of rows) {
    const completion = workflowCompletion(row, window.until), snapshot = workflowSnapshot(row, window.until);
    if (completion.unknownTime) report.coverage.unknownCompletionTimes++;
    if (snapshot.closedWithoutIntegration) report.coverage.closedWithoutIntegration++;
    if (!snapshot.closed) {
      if (snapshot.unknown) report.flow.unknownState++;
      else { const stage = stages.find(stage => stage.id === snapshot.stage)!; stage.wip++; report.flow.wip++;
        if (snapshot.blocked) { stage.blocked++; report.flow.blocked++; } else if (!snapshot.blockedKnown) { stage.blockedUnknown++; report.flow.blockedUnknown++; }
        ages.get(stage.id)!.push(snapshot.age);
      }
    }
    if (completion.at !== null && completion.at >= window.since && completion.at < window.until) {
      report.throughput.completed++;
      const weekStart = workflowWeekStart(completion.at), week = weeks.find(week => Date.parse(week.weekStart) === weekStart); if (week) week.completed++;
      lead.push(row.submittedAt !== null && row.submittedAt <= completion.at ? completion.at - row.submittedAt : null);
      const started = workflowCycleStart(row, completion.at); cycle.push(started === null ? null : completion.at - started);
    }
    for (const [kind, metric] of [['rework', report.rework], ['failure', report.failures]] as const) {
      const count = workflowEvidenceCounts(row, window.since, window.until, kind); if (count) metric.requests++; metric.observations += count;
      if (row.request && row.complete) metric.measuredRequests++; else metric.unknownRequests++;
    }
  }
  for (const stage of stages) { const values = ages.get(stage.id)!; stage.age = workflowDistribution(values); const known = values.filter((value): value is number => value !== null); stage.oldestAgeMs = known.length ? Math.max(...known) : null; }
  report.timing = { lead: workflowDistribution(lead), cycle: workflowDistribution(cycle) };
  if (report.throughput.completeWeeks) report.throughput.meanPerCompleteWeek = weeks.filter(week => !week.partial).reduce((sum, week) => sum + week.completed, 0) / report.throughput.completeWeeks;
  return report;
}
