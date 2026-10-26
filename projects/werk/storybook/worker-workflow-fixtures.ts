import { h, KeepAlive } from 'vue';
import UApp from '@nuxt/ui/components/App.vue';
import WorkerShell from '../src/worker/webview/components/WorkerShell.vue';
import WorkflowPage from '../src/worker/webview/pages/WorkflowPage.vue';
import { workerLinks } from '../src/worker/webview/worker-navigation';
import { buildWorkflowMetrics } from '../src/worker/application/workflow-metrics';
import type { WorkflowMetricsQuery, WorkflowMetricsReport } from '../src/worker/application/workflow-metrics-contracts';
import { installWorkerFixture } from './worker-fixtures';
import { state } from '../src/worker/webview/store';
export type WorkflowScenario = 'populated' | 'empty' | 'unmeasured' | 'paused' | 'loading';
const hour = 3_600_000;
/** In-memory illustrative report. No provider, Git operation, request mutation or business measurement occurs. */
function workflowExample(query: WorkflowMetricsQuery = {}, scenario: WorkflowScenario = 'populated'): WorkflowMetricsReport {
  const now = new Date().toISOString(), report = buildWorkflowMetrics({ requests: [], events: [], runs: [], completeRequestIds: [] }, query, now);
  report.projects = query.projectId ? [query.projectId] : ['atlas', 'portal']; report.profiles = ['feature'];
  report.notes.unshift('Illustrative Storybook observations only. No provider, Git command or runtime measurement was executed.');
  if (scenario === 'empty' || scenario === 'loading') return report;
  const unmeasured = scenario === 'unmeasured', portal = query.projectId === 'portal';
  const counts = unmeasured ? [0, 0, 1, 0, 1, 0, 0, 0] : portal ? [1, 0, 0, 0, 1, 0, 0, 0] : [2, 1, 2, 1, 3, 1, 0, 0];
  for (let index = 0; index < 8; index++) {
    const stage = report.flow.stages[index], wip = counts[index];
    Object.assign(stage, { wip, blocked: !unmeasured && !portal && [0, 2, 4].includes(index) ? 1 : 0, blockedUnknown: unmeasured && wip ? 1 : 0,
      age: { samples: unmeasured ? 0 : wip, unknown: unmeasured ? wip : 0, p50Ms: wip && !unmeasured ? 2 * hour : null, p95Ms: wip && !unmeasured ? (index + 1) * 4 * hour : null, totalMs: wip && !unmeasured ? wip * 2 * hour : null }, oldestAgeMs: wip && !unmeasured ? (index + 1) * 4 * hour : null });
  }
  report.flow.wip = counts.reduce((sum, value) => sum + value, 0); report.flow.blocked = unmeasured || portal ? 0 : 3; report.flow.blockedUnknown = unmeasured ? 2 : 0; report.flow.unknownState = unmeasured ? 2 : 0;
  if (report.throughput.weeks.length) {
    report.throughput.weeks.forEach((week, index) => { const age = report.throughput.weeks.length - 1 - index; week.completed = unmeasured ? age === 1 ? 3 : 0 : portal ? age === 1 ? 2 : 0 : age < 6 ? [1, 4, 2, 3, 1, 2][age] : 0; });
    report.throughput.completed = report.throughput.weeks.reduce((sum, week) => sum + week.completed, 0);
    report.throughput.meanPerCompleteWeek = report.throughput.completeWeeks ? report.throughput.weeks.filter(week => !week.partial).reduce((sum, week) => sum + week.completed, 0) / report.throughput.completeWeeks : null;
  }
  report.coverage = { canonicalRequests: unmeasured ? 8 : portal ? 5 : 24, intakeOnly: portal || unmeasured ? 0 : 2, completeHistories: unmeasured ? 0 : portal ? 4 : 18, unknownSubmissionTimes: unmeasured ? 2 : 1, closedWithoutIntegration: 1, unknownCompletionTimes: unmeasured ? 2 : 1 };
  const completed = report.throughput.completed, leadSamples = unmeasured ? 0 : Math.max(0, completed - 2), cycleSamples = unmeasured ? 0 : Math.max(0, completed - 3);
  report.timing = { lead: { samples: leadSamples, unknown: completed - leadSamples, p50Ms: leadSamples ? 36 * hour : null, p95Ms: leadSamples ? 96 * hour : null, totalMs: leadSamples ? leadSamples * 40 * hour : null }, cycle: { samples: cycleSamples, unknown: completed - cycleSamples, p50Ms: cycleSamples ? 9 * hour : null, p95Ms: cycleSamples ? 30 * hour : null, totalMs: cycleSamples ? cycleSamples * 12 * hour : null } };
  report.rework = { requests: unmeasured ? 0 : 2, observations: unmeasured ? 0 : 3, measuredRequests: unmeasured ? 0 : 18, unknownRequests: unmeasured ? 8 : 6 };
  report.failures = { requests: unmeasured ? 0 : 1, observations: unmeasured ? 0 : 1, measuredRequests: unmeasured ? 0 : 18, unknownRequests: unmeasured ? 8 : 6 };
  return report;
}
export function installWorkflowFixture(scenario: WorkflowScenario = 'populated') {
  const base = installWorkerFixture('empty'), queries: WorkflowMetricsQuery[] = [];
  let unavailable = false;
  state.paused = scenario === 'paused';
  const original = (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__;
  (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href), body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (url.pathname === '/api/requests' && body.action === 'workflow_metrics') {
      const { action: _action, ...query } = body; queries.push(query);
      if (scenario === 'loading') return new Promise<Response>(() => {});
      if (unavailable) return Response.json({ error: 'The retained workflow journal is temporarily unavailable.' }, { status: 503 });
      return Response.json(workflowExample(query, scenario));
    }
    return original(input, init);
  };
  return { ...base, queries, setUnavailable(value: boolean) { unavailable = value; } };
}
export function renderWorkflow(scenario: WorkflowScenario, ready: (fixture: ReturnType<typeof installWorkflowFixture>) => void) {
  return () => ({ setup() {
    const fixture = installWorkflowFixture(scenario); ready(fixture);
    return () => h(UApp, null, { default: () => h(WorkerShell, { links: workerLinks, homePath: '/taskboard', homeLabel: 'Werk worker home', navLabel: 'Worker pages' }, {
      identity: () => h('div', { class: 'worker-identity' }, [h('div', [h('strong', 'Atlas worker'), h('span', 'Illustrative data · no commands executed')])]),
      default: () => h(KeepAlive, null, { default: () => h(WorkflowPage) }),
      footer: () => 'Isolated workflow fixture · no customer or business outcomes connected',
    }) });
  } });
}
