import { reactive } from 'vue';
import { createFactoryStore } from '../../src/factory/webview/store';
import { createOrchestratorStore, firstPage } from '../../src/orchestrator/webview/store';
import type { Factory, OrchestratorOverview, ProductionLine } from '../../src/shared/factory';

/** Public, synthetic observations. These fixtures never connect to a runtime. */
export const observedAt = '2026-10-15T09:30:00.000Z';
export const observedMs = Date.parse(observedAt);
export const factories: Factory[] = [
  { id: 'studio', name: 'Product Studio', parentId: null },
  { id: 'platform', name: 'Platform', parentId: 'studio' },
];
export const lines: ProductionLine[] = [
  { id: 'alpha', name: 'Customer experience', factoryId: 'studio', orchestratorUrl: 'https://alpha.example.invalid', webviewUrl: 'https://alpha.example.invalid', tokenEnv: 'WERK_LINE_ALPHA_TOKEN' },
  { id: 'beta', name: 'Platform services', factoryId: 'platform', orchestratorUrl: 'https://beta.example.invalid', webviewUrl: 'https://beta.example.invalid', tokenEnv: 'WERK_LINE_BETA_TOKEN' },
];
export const overview: OrchestratorOverview = {
  schemaVersion: 1, observedAt, mode: 'mixed', project: 'customer-portal',
  tasks: { total: 5, queued: 1, running: 1, simulated: 1, review: 1, blocked: 1 },
  workers: { total: 3, online: 2, offline: 1, slotsTotal: 4, slotsBusy: 1, slotsAvailable: 3 },
  snapshots: { total: 6, before: 3, after: 3 },
  cost: { amountUsd: null, reason: 'unavailable_provider' },
};
export const tasks = [
  { id: 'task-ready', title: 'Clarify account permissions', status: 'queued', priority: 2, attempt: 0, workerId: null, profile: null, executionMode: 'mock', project: 'customer-portal', provider: 'auto', createdAt: observedMs - 120000 },
  { id: 'task-running', title: 'Exercise the onboarding flow', status: 'running', priority: 1, attempt: 1, workerId: 'worker-a', profile: 'simulation', executionMode: 'mock', project: 'customer-portal', provider: 'codex', createdAt: observedMs - 240000 },
  { id: 'task-review', title: 'Review the accessible taskboard patch', status: 'review', priority: 1, attempt: 1, workerId: 'worker-b', profile: 'native-codex', executionMode: 'cli', project: 'customer-portal', provider: 'codex', createdAt: observedMs - 480000 },
  { id: 'task-blocked', title: 'Resolve an ambiguous export requirement', status: 'blocked', priority: 1, attempt: 1, workerId: 'worker-a', profile: 'simulation', executionMode: 'mock', project: 'customer-portal', provider: 'auto', createdAt: observedMs - 600000 },
  { id: 'task-simulated', title: 'Verify line routing with a simulation', status: 'simulated', priority: 1, attempt: 1, workerId: 'worker-a', profile: 'simulation', executionMode: 'mock', project: 'customer-portal', provider: 'auto', createdAt: observedMs - 900000 },
];

function unhandledRequest(app: string, method: string, path: string): never {
  const message = `${app} story has no fixture for ${method} ${path}`;
  const globals = globalThis as typeof globalThis & { __WERK_STORY_ERRORS__?: string[] };
  (globals.__WERK_STORY_ERRORS__ ??= []).push(message);
  throw Error(message);
}

const tasksForLine = (id: string) => tasks.filter((_, index) => id === 'alpha' ? index < 3 : index >= 3);
function taskCounts(rows: typeof tasks) {
  return { total: rows.length, queued: rows.filter(task => task.status === 'queued').length,
    running: rows.filter(task => task.status === 'running').length,
    simulated: rows.filter(task => task.status === 'simulated').length,
    review: rows.filter(task => task.status === 'review').length,
    blocked: rows.filter(task => task.status === 'blocked').length };
}

export function factoryFixture(options: { empty?: boolean; unavailable?: boolean } = {}) {
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input), 'https://storybook.example.invalid');
    const method = init?.method ?? 'GET';
    const match = /^\/v1\/lines\/(alpha|beta)\/tasks$/.exec(path.pathname);
    if (match && method === 'GET') {
      if (options.unavailable && match[1] === 'beta') return Response.json({ error: 'Fixture: this line is temporarily unavailable.' }, { status: 503 });
      return Response.json({ lineId: match[1], checkedAt: observedAt, tasks: options.empty ? [] : tasksForLine(match[1]), hasMore: false, nextCursor: null });
    }
    const knownMutation = (method === 'POST' && ['/v1/factories', '/v1/lines', '/v1/intake'].includes(path.pathname))
      || (['PATCH', 'DELETE'].includes(method) && /^\/v1\/(?:factories\/(?:studio|platform)|lines\/(?:alpha|beta))$/.test(path.pathname))
      || (method === 'PUT' && /^\/v1\/(?:factories\/(?:studio|platform)|intake\/(?:intake-queued|intake-delivered))\/routing$/.test(path.pathname));
    if (knownMutation) return Response.json({ error: 'Read-only fixture: this example does not save changes to a Factory.' }, { status: 405 });
    return unhandledRequest('Factory', method, path.pathname);
  };
  const store = createFactoryStore(fetcher);
  const available = options.empty ? 0 : options.unavailable ? 1 : 2;
  const scaled = <T extends object>(group: T): T => Object.fromEntries(Object.entries(group).map(([key, value]) => [key, Number(value) * available])) as T;
  Object.assign(store.state, {
    token: 'synthetic-story-session', canWrite: true, role: 'Administration',
    factories: structuredClone(factories), lines: options.empty ? [] : structuredClone(lines), scope: 'studio',
    message: '', intakeFactory: 'studio', intakeOpen: true, paused: true,
    overview: {
      factoryId: 'studio', observedAt, factories: structuredClone(factories),
      lines: (options.empty ? [] : lines).map((line, index) => ({
        line: structuredClone(line), checkedAt: observedAt,
        status: options.unavailable && index === 1 ? 'unavailable' : 'available',
        error: options.unavailable && index === 1 ? 'Last contact failed. Totals include available lines only.' : null,
        overview: options.unavailable && index === 1 ? null : { ...structuredClone(overview), tasks: taskCounts(tasksForLine(line.id)) },
      })),
      totals: { lines: options.empty ? 0 : 2, availableLines: available, unavailableLines: options.unavailable ? 1 : 0, partial: !!options.unavailable, tasks: taskCounts(options.empty ? [] : options.unavailable ? tasksForLine('alpha') : tasks), workers: scaled(overview.workers), snapshots: scaled(overview.snapshots), cost: structuredClone(overview.cost) },
    },
    queue: { total: 2, queued: 1, delivering: 0, delivered: 1, tasks: [
      { id: 'intake-queued', factoryId: 'studio', lineId: null, status: 'queued', reason: 'Waiting for a compatible free worker', task: { title: 'Improve keyboard navigation', project: 'customer-portal' }, destination: null, remoteTaskId: null },
      { id: 'intake-delivered', factoryId: 'studio', lineId: 'alpha', status: 'delivered', reason: 'Acknowledged by Customer experience', task: { title: 'Review the taskboard patch', project: 'customer-portal' }, destination: structuredClone(lines[0]), remoteTaskId: 'task-review' },
    ] },
  });
  Object.assign(store.state.taskDraft, { project: 'customer-portal', title: 'Improve keyboard navigation', criteria: 'Every task is reachable with the keyboard. Focus remains visible after opening a task.' });
  return store;
}

export const workers = [
  { id: 'worker-a', project: 'customer-portal', online: true, seen: observedMs, config: { maxParallel: 2, maxAttempts: 3, order: 'fifo' }, profiles: [{ id: 'simulation', provider: 'codex', mode: 'mock', maxParallel: 2 }] },
  { id: 'worker-b', project: 'customer-portal', online: true, seen: observedMs, config: { maxParallel: 1, maxAttempts: 2, order: 'fifo' }, profiles: [{ id: 'native-codex', provider: 'codex', mode: 'cli', maxParallel: 1 }] },
  { id: 'worker-c', project: 'customer-portal', online: false, seen: observedMs - 3600000, config: { maxParallel: 1, maxAttempts: 3, order: 'fifo' }, profiles: [{ id: 'simulation', provider: 'claude', mode: 'mock', maxParallel: 1 }] },
];

export function orchestratorFixture(options: { empty?: boolean } = {}) {
  const store = createOrchestratorStore({
    now: () => observedMs,
    uuid: () => 'synthetic-story-operation',
    reactive: value => reactive(value) as typeof value,
    request: async (input, init) => {
      const path = new URL(input, 'https://storybook.example.invalid').pathname;
      const method = init.method ?? 'GET';
      const knownMutation = (method === 'POST' && path === '/v1/tasks')
        || (method === 'PUT' && (path === '/v1/routing' || /^\/v1\/tasks\/task-(?:ready|running|review|blocked|simulated)\/routing$/.test(path)));
      if (knownMutation) throw Object.assign(Error('Read-only fixture: this example does not save changes to an orchestrator.'), { status: 405 });
      return unhandledRequest('Orchestrator', method, path);
    },
  });
  const records = options.empty ? [] : structuredClone(tasks);
  Object.assign(store.state, {
    token: 'synthetic-story-session', canWrite: true, role: 'Administration', paused: true,
    overview: structuredClone(overview), tasks: records, workers: options.empty ? [] : structuredClone(workers),
    taskPage: { ...firstPage(), loaded: true, count: records.length },
    workerPage: { ...firstPage(), loaded: true, count: options.empty ? 0 : workers.length },
    refreshedAt: observedMs, sync: 'Synthetic fixture · no live services',
  });
  Object.assign(store.state.intake, { project: 'customer-portal', requirementRef: '[[Features/Accessible taskboard]]', title: 'Improve keyboard navigation', criteria: 'Every task is reachable by keyboard. Selected tasks expose a visible focus state.' });
  Object.assign(store.state.routing, { loaded: true, workers: structuredClone(workers) });
  return store;
}

export function metricFixtures() {
  return [0, 1, 2].flatMap(index => ['before', 'after'].map(phase => ({
    receivedAt: new Date(observedMs - (3 - index) * 60000 + (phase === 'after' ? 15000 : 0)).toISOString(),
    sha256: 'a'.repeat(64),
    snapshot: {
      id: `snapshot-${index}-${phase}`, pairId: `pair-${index}`, taskId: `simulated-task-${index}`,
      project: 'customer-portal', workerId: 'worker-a', profileId: 'simulation', attempt: 1,
      phase, mode: 'mock', execution: { outcome: phase === 'before' ? 'running' : 'simulated', durationMs: phase === 'after' ? 6000 + index * 2400 : null },
      resources: { rssBytes: (100 + index * 8) * 1048576 }, health: { eventLoopDelayP95Ms: 2.4 + index * 0.2 },
    },
  })));
}
