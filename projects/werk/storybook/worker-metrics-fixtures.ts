import { h, KeepAlive } from 'vue';
import UApp from '@nuxt/ui/components/App.vue';
import MonitoringPage from '../src/worker/webview/pages/MonitoringPage.vue';
import WorkerShell from '../src/worker/webview/components/WorkerShell.vue';
import { defaultResourcePolicy, type ResourceStatus } from '../src/worker/application/resources';
import type { RunAnalysis, RunOutcome, RunQuery } from '../src/worker/application/run-evidence';
import type { ConsumptionStatus } from '../src/worker/application/consumption';
import { workerCapacitySnapshot } from '../src/worker/application/worker-capacity';
import { state } from '../src/worker/webview/store';
import { installWorkerFixture } from './worker-fixtures';

export type MetricsScenario = 'active' | 'exhausted' | 'uncertain' | 'empty' | 'stale' | 'accounting-unavailable' | 'limits-off' | 'pressure';
interface ExampleAttempt { acceptedAt: string; outcome: RunOutcome; durationMs: number | null; inputTokens: number | null; outputTokens: number | null; cost: number | null; }
const hour = 3_600_000;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const iso = (value: number) => new Date(value).toISOString();

/** Fictional attempt dates are relative to the browser clock; filters use acceptedAt, as the worker does. */
function attempts(now: number, empty: boolean): ExampleAttempt[] {
  if (empty) return [];
  const outcomes: RunOutcome[] = ['running', 'queued', 'completed', 'review', 'waiting_input', 'failed', 'completed', 'completed', 'cancelled', 'interrupted', 'completed', 'escalated'];
  return [0.1, 0.5, 2, 4, 8, 12, 48, 96, 144, 240, 480, 960].map((age, index) => ({
    acceptedAt: iso(now - age * hour), outcome: outcomes[index], durationMs: index < 2 ? null : (index + 1) * 95_000,
    inputTokens: index < 2 || index === 5 ? null : (index + 1) * 1200,
    outputTokens: index < 2 || index === 5 ? null : (index + 1) * 300,
    cost: index < 2 || index === 5 || index === 8 ? null : (index + 1) * 0.024,
  }));
}
function analyze(examples: ExampleAttempt[], query: RunQuery): RunAnalysis {
  const matching = examples.filter(item => (!query.since || item.acceptedAt >= query.since) && (!query.until || item.acceptedAt <= query.until));
  const durations = matching.flatMap(item => item.durationMs === null ? [] : [item.durationMs]);
  const coverage = (key: 'inputTokens' | 'outputTokens' | 'cost') => matching.filter(item => item[key] !== null).length;
  const sum = (key: 'inputTokens' | 'outputTokens' | 'cost') => coverage(key) ? matching.reduce((total, item) => total + (item[key] ?? 0), 0) : null;
  const outcomes: Record<string, number> = {};
  for (const item of matching) outcomes[item.outcome] = (outcomes[item.outcome] ?? 0) + 1;
  return {
    schemaVersion: 1, scope: 'worker_session_executions', asOf: examples.length, total: matching.length,
    completedPairs: durations.length, outcomes,
    consumption: {
      runs: matching.length, reportedRuns: coverage('inputTokens'), inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
      cacheReadTokens: null, cacheWriteTokens: null, providerReportedCostUsd: sum('cost'),
      coverage: { inputTokens: coverage('inputTokens'), outputTokens: coverage('outputTokens'), cacheReadTokens: 0, cacheWriteTokens: 0, providerReportedCostUsd: coverage('cost') },
    },
    duration: { measuredRuns: durations.length, totalMs: durations.length ? durations.reduce((a, b) => a + b, 0) : null, meanMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null },
    resources: { scope: 'worker_process_between_snapshots', measuredRuns: durations.length, cpuUserMicros: durations.length ? durations.length * 500_000 : null, cpuSystemMicros: durations.length ? durations.length * 80_000 : null, peakObservedRssBytes: durations.length ? 246_000_000 : null },
    notes: ['Fictional retained attempts, filtered by acceptance time. No model calls or verification commands were run.'],
  };
}

/** Isolated data and controlled read failures; no runtime mutation is allowed. */
function installMetricsFixture(scenario: MetricsScenario = 'active') {
  const empty = scenario === 'empty';
  const blocked = ['exhausted', 'uncertain', 'accounting-unavailable'].includes(scenario);
  const base = installWorkerFixture(empty ? 'empty' : blocked ? 'capacity-blocked' : 'running');
  const now = Date.now(), capturedAt = iso(now), startedAt = iso(now - 6 * 60_000);
  const start = new Date(now); start.setUTCHours(0, 0, 0, 0);
  const policy = { enabled: scenario !== 'limits-off', period: 'daily' as const, allowance: 1_000_000, workerPercent: 50, perRunReservation: 10_000 };
  const consumption: ConsumptionStatus = {
    schemaVersion: 1, policy, periodStart: start.toISOString(), periodEnd: iso(start.getTime() + 24 * hour),
    workerAllowance: 500_000, measuredTokens: empty ? 0 : 125_000, reservedTokens: empty ? 0 : 10_000,
    chargedTokens: empty ? 0 : 135_000, remainingTokens: empty ? 500_000 : 365_000,
    activeInvocations: empty || blocked ? 0 : 1, uncertainInvocations: scenario === 'uncertain' ? 1 : 0,
    blocked, reason: scenario === 'limits-off' ? 'disabled' : 'available', accountingAvailable: true, trackingStartedAt: start.toISOString(),
  };
  if (scenario === 'exhausted') Object.assign(consumption, { measuredTokens: 505_130, reservedTokens: 0, chargedTokens: 505_130, remainingTokens: 0, reason: 'exhausted' });
  if (scenario === 'uncertain') consumption.reason = 'unmeasured_usage';
  if (scenario === 'accounting-unavailable') Object.assign(consumption, { measuredTokens: 0, reservedTokens: 0, chargedTokens: 0, remainingTokens: 500_000, reason: 'accounting_unavailable', accountingAvailable: false, trackingStartedAt: null });
  state.consumption = consumption;
  state.settings!.consumption = policy;
  state.status!.project = 'Atlas documentation';
  state.status!.workerId = 'atlas-local-worker';
  state.status!.updatedAt = capturedAt;
  state.environment!.capturedAt = capturedAt;
  state.environment!.hostname = 'atlas-workstation';
  state.environment!.uptimeSeconds = empty ? 9 : 49_620;
  Object.assign(state, { lastRead: capturedAt, statusReadAt: capturedAt, statusError: '', environmentReadAt: capturedAt, environmentError: '', consumptionReadAt: capturedAt, consumptionError: '', sessionsReadAt: capturedAt, sessionsStale: false });
  const current = state.sessions!.records.find(item => item.id === 'running');
  if (current) current.title = 'Improve API onboarding';
  const sessions = state.sessions!;
  if (!empty && !blocked) { sessions.records = sessions.records.filter(item => item.id !== 'docs'); sessions.execution.queued = 1; }
  sessions.capacity = workerCapacitySnapshot({ capturedAt, currentSessionId: sessions.execution.currentSessionId, localUsed: sessions.records.filter(item => item.kind !== 'orchestrator' && item.busy).length, settings: state.settings!.board, remote: { waiting: 0, running: 0 }, consumption });
  const resource: ResourceStatus = {
    schemaVersion: 1, sampleIntervalMs: 10_000, policy: defaultResourcePolicy(), alerts: [], persistenceError: false, sampleError: false, sampleErrorReason: null,
    snapshot: {
      capturedAt, scope: 'worker_node_process', processId: 1234, processStartId: 'example-worker-process',
      rssBytes: 246_000_000, effectiveMemoryLimitBytes: 8_000_000_000, heapUsedBytes: 98_000_000, heapLimitBytes: 2_000_000_000,
      cpuPercent: empty ? null : 18.4, cpuCores: empty ? null : 1.472, cpuCapacityCores: 8, cpuCapacityBasis: 'available_parallelism',
      availableMemoryBytes: 8_000_000_000, diskAvailableBytes: 72_000_000_000, diskTotalBytes: 100_000_000_000,
      unavailable: empty ? ['cpu'] : [], active: sessions.execution.currentSessionId ? { sessionId: sessions.execution.currentSessionId, startedAt, elapsedMs: 360_000 } : null,
    },
  };
  if (scenario === 'pressure') {
    resource.snapshot!.rssBytes = 7_100_000_000;
    resource.snapshot!.diskAvailableBytes = 3_000_000_000;
    state.environment!.disk!.freeBytes = 3_000_000_000;
    resource.alerts = [
      { id: 'example-memory-alert', code: 'memory', severity: 'warning', openedAt: iso(now - 60_000), sessionId: 'running', observed: 88.75, threshold: 85 },
      { id: 'example-disk-alert', code: 'disk', severity: 'warning', openedAt: iso(now - 120_000), observed: 3, threshold: 5 },
    ];
  }
  const examples = attempts(now, empty), analyses: RunQuery[] = [];
  if (blocked && examples.length) examples[0].outcome = 'queued';
  let offline = false, hold = false;
  const pending: Array<() => void> = [];
  let resourcesRead = 0;
  const fetchFixture: typeof fetch = async (input, init = {}) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (path === '/api/runs' && body.action === 'analyze') {
      analyses.push(copy(body));
      if (hold) await new Promise<void>(resolve => pending.push(resolve));
      return offline ? Response.json({ error: 'Example worker is offline. Previously loaded activity is retained.' }, { status: 503 }) : Response.json(analyze(examples, body));
    }
    if (path === '/api/resources' && (!init.method || init.method === 'GET')) {
      resourcesRead++;
      if (hold) await new Promise<void>(resolve => pending.push(resolve));
      return offline ? Response.json({ error: 'Example resource refresh failed. Last reported sample is retained.' }, { status: 503 }) : Response.json(resource);
    }
    if (offline && ['/status', '/api/environment', '/api/consumption'].includes(path)) return Response.json({ error: 'Example worker is offline.' }, { status: 503 });
    if (path === '/api/consumption') return Response.json(consumption);
    if (path === '/status') return Response.json(state.status);
    if (path === '/api/environment') return Response.json(state.environment);
    if (path === '/api/settings') return Response.json(state.settings);
    if (path === '/api/chat/session') return Response.json({ sessions, chat: state.chat });
    return base.fetchFixture(input, init);
  };
  (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = fetchFixture;
  return {
    analyses, get resourcesRead() { return resourcesRead; },
    holdReads() { hold = true; },
    releaseReads() { hold = false; pending.splice(0).forEach(resolve => resolve()); },
    markOffline() {
      offline = true;
      Object.assign(state, { error: 'Example worker is offline. Cached values are not current.', statusError: 'Worker status could not be refreshed.', environmentError: 'Environment could not be refreshed.', consumptionError: 'Consumption could not be refreshed.', sessionsStale: true });
      state.refreshRevision++;
    },
  };
}
let currentFixture: ReturnType<typeof installMetricsFixture>;
export const metricsFixture = () => currentFixture;
const links = [{ path: '/taskboard', label: 'Taskboard', icon: 'i-lucide-columns-2' }, { path: '/dashboard', label: 'Metrics', icon: 'i-lucide-activity' }, { path: '/history', label: 'History', icon: 'i-lucide-history' }, { path: '/settings', label: 'Settings', icon: 'i-lucide-settings-2' }];
export function renderMetricsPage(scenario: MetricsScenario = 'active') {
  return () => ({ setup() {
    currentFixture = installMetricsFixture(scenario);
    return () => h(UApp, null, { default: () => h(WorkerShell, { links, homePath: '/taskboard', homeLabel: 'Werk worker home', navLabel: 'Worker pages' }, {
      identity: () => h('div', { class: 'worker-identity' }, [h('div', [h('strong', 'Atlas documentation'), h('span', 'Worker Storybook · fictional data')])]),
      status: () => 'Isolated example · no model connected',
      default: () => h(KeepAlive, null, { default: () => h(MonitoringPage) }),
      footer: () => 'Fictional metrics · no provider calls or runtime changes',
    }) });
  } });
}
