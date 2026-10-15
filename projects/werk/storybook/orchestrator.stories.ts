import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { h, toRaw, type Component } from 'vue';
import { expect, within, userEvent } from 'storybook/test';
import OrchestratorApp from '../src/orchestrator/webview/App.vue';
import DashboardPage from '../src/orchestrator/webview/pages/DashboardPage.vue';
import IntakePage from '../src/orchestrator/webview/pages/IntakePage.vue';
import TasksPage from '../src/orchestrator/webview/pages/TasksPage.vue';
import WorkersPage from '../src/orchestrator/webview/pages/WorkersPage.vue';
import MetricsPage from '../src/orchestrator/webview/pages/MetricsPage.vue';
import Pagination from '../src/orchestrator/webview/components/Pagination.vue';
import { metricFixtures, observedAt, observedMs, orchestratorFixture, workers } from './fixtures/portfolio';

const meta = { title: 'Orchestrator/Line operations', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type Fixture = ReturnType<typeof orchestratorFixture>;
const map = (component: string, summary: string, step: number) => ({ storymap: {
  app: 'Orchestrator', summary, journey: 'Request to evidence', step,
  route: ({ 'pages/DashboardPage': '/system', 'pages/IntakePage': '/intake', 'pages/TasksPage': '/tasks', 'pages/WorkersPage': '/workers', 'pages/MetricsPage': '/metrics' } as Record<string, string>)[component] ?? '/',
  covers: [`src/orchestrator/webview/${component}.vue`],
} });
function panel(component: Component, title: string, configure: (store: Fixture) => void = () => {}, options = {}) {
  return () => ({ setup() {
    const store = orchestratorFixture(options);
    configure(store);
    return () => h('main', { style: 'padding:32px;max-width:1440px;margin:auto;min-width:0' }, [
      h('p', { class: 'eyebrow' }, 'Orchestrator · isolated example'),
      h('h1', { style: 'font-size:1.8rem;font-weight:650;margin-bottom:24px' }, title),
      h(component, { store }),
    ]);
  } });
}
function review(store: Fixture, blocked = false) {
  store.state.tab = 'tasks';
  store.state.selectedTask = structuredClone(toRaw(store.state.tasks.find(task => task.id === (blocked ? 'task-blocked' : 'task-review'))!));
  store.state.events = [
    { seq: 1, kind: 'task.created', at: observedAt, detail: { message: 'Request durably recorded by this line.' } },
    { seq: 2, kind: 'task.leased', at: observedAt, detail: { workerId: blocked ? 'worker-a' : 'worker-b', attempt: 1 } },
    { seq: 3, kind: 'task.completed', at: observedAt, detail: { status: blocked ? 'blocked' : 'review', message: blocked ? 'Acceptance criterion remains unresolved.' : 'Local patch recorded. Human review is required before publication.' } },
  ];
  store.state.eventPage = { ...store.state.eventPage, loaded: true, count: 3 };
}

export const Access: Story = {
  name: '01 · Access and line boundaries',
  parameters: map('App', 'The orchestrator access screen identifies its separate line credential and role boundary.', 1),
  render: () => ({ render: () => h(OrchestratorApp) }),
};
export const Dashboard: Story = {
  name: '02 · Production line dashboard',
  parameters: map('pages/DashboardPage', 'Observe queued requests, available workers and results without equating simulations with implementation.', 2),
  render: panel(DashboardPage, 'Production line overview'),
};
export const DashboardStale: Story = {
  name: '03 · Stale line observation',
  parameters: map('pages/DashboardPage', 'Stale observations remain visibly qualified while the operator checks the connection.', 2),
  render: panel(DashboardPage, 'Check the last observation', store => { store.state.stale = true; }),
};
export const IntakeReference: Story = {
  name: '04 · Request from a requirement reference',
  parameters: map('pages/IntakePage', 'Submit a pinned requirement reference with a project, provider and explicit execution mode.', 3),
  render: panel(IntakePage, 'Prepare a referenced request'),
};
export const IntakeManual: Story = {
  name: '05 · Feature and acceptance criteria',
  parameters: map('pages/IntakePage', 'A manual feature provides a title and acceptance criteria; simulation remains the default.', 3),
  render: panel(IntakePage, 'Describe a feature', store => { store.state.intake.mode = 'manual'; }),
};
export const IntakeReadOnly: Story = {
  name: '06 · Intake without write access',
  parameters: map('pages/IntakePage', 'A viewer sees why an operator role is required before submitting new work.', 3),
  render: panel(IntakePage, 'Viewer access', store => { store.state.canWrite = false; }),
};
export const Tasks: Story = {
  name: '07 · Taskboard across execution states',
  parameters: map('pages/TasksPage', 'Queued, active, review, blocked and simulated requests remain distinct on the line taskboard.', 4),
  render: panel(TasksPage, 'Work in this line', store => { store.state.tab = 'tasks'; }),
};
export const TasksTable: Story = {
  name: '08 · Task table',
  parameters: map('pages/TasksPage', 'The alternative task table exposes project, provider and attempt alongside the same request statuses.', 4),
  render: panel(TasksPage, 'Compare task attempts', store => { store.state.tab = 'tasks'; }),
  play: async ({ canvasElement }) => { await userEvent.click(within(canvasElement).getByRole('button', { name: 'Tabelle' })); },
};
export const EmptyTasks: Story = {
  name: '09 · Empty taskboard',
  parameters: map('pages/TasksPage', 'An empty page guides the next intake action instead of implying a successful completed queue.', 4),
  render: panel(TasksPage, 'No requests on this page', () => {}, { empty: true }),
};
export const ReviewEvidence: Story = {
  name: '10 · Review and event evidence',
  parameters: map('pages/TasksPage', 'A review task retains attempt events, local-patch guidance and the fact that missing gate evidence is not acceptance.', 5),
  render: panel(TasksPage, 'Review a recorded attempt', store => review(store)),
  play: async ({ canvasElement }) => { await expect(within(canvasElement).getByRole('heading', { name: /Review the accessible taskboard patch · Ereignisse/ })).toBeVisible(); },
};
export const BlockedEvidence: Story = {
  name: '11 · Blocked task evidence',
  parameters: map('pages/TasksPage', 'A held request keeps its event history and directs the operator to clarify the requirement.', 5),
  render: panel(TasksPage, 'Understand a held request', store => review(store, true)),
};
export const WorkerRoster: Story = {
  name: '12 · Worker roster and execution profiles',
  parameters: map('pages/WorkersPage', 'The line exposes online and offline workers with their machine slots and simulated or native profiles.', 6),
  render: panel(WorkersPage, 'Inspect line capacity', store => { store.state.tab = 'workers'; }),
};
export const WorkerConfiguration: Story = {
  name: '13 · Worker detail and active lease',
  parameters: map('pages/WorkersPage', 'A worker detail connects machine limits, execution profiles and the active reservation without editing its configuration.', 6),
  render: panel(WorkersPage, 'Worker configuration and reservations', store => {
    store.state.workerId = 'worker-a';
    store.state.workerDetail = { ...structuredClone(workers[0]), activeTasks: [{ id: 'task-running', attempt: 1, profile: 'simulation', expiresAt: observedMs + 60000 }], activeTasksTruncated: false };
  }),
};
export const WorkerUnavailable: Story = {
  name: '14 · Unavailable worker detail',
  parameters: map('pages/WorkersPage', 'A failed detail read reports an unavailable observation rather than showing stale configuration as current.', 6),
  render: panel(WorkersPage, 'Worker observation unavailable', store => { store.state.workerId = 'worker-c'; store.state.workerError = 'The worker detail could not be refreshed. Retry after checking its connection.'; }),
};
export const Metrics: Story = {
  name: '15 · Before and after measurements',
  parameters: map('pages/MetricsPage', 'Paired snapshots show measured durations and explicitly distinguish unavailable cost and unverified quality.', 7),
  render: panel(MetricsPage, 'Compare recorded attempts', store => { store.state.metrics = metricFixtures(); }),
};
export const SnapshotDetail: Story = {
  name: '16 · Inspect an individual snapshot',
  parameters: map('pages/MetricsPage', 'An individual snapshot preserves identifiers, provenance, hash and original evidence data.', 7),
  render: panel(MetricsPage, 'Inspect recorded evidence', store => { store.state.metrics = metricFixtures(); store.state.selectedSnapshot = store.state.metrics[1]; }),
};
export const EmptyMetrics: Story = {
  name: '17 · No measurements',
  parameters: map('pages/MetricsPage', 'Empty metrics report that no attempts have been measured and do not manufacture zero-cost or quality claims.', 7),
  render: panel(MetricsPage, 'Measurements appear after attempts'),
};
export const BoundedPagination: Story = {
  name: '18 · Bounded result pagination',
  parameters: map('components/Pagination', 'Pagination shows a bounded loaded page and preserves separate previous, next and refresh controls.', 4),
  render: () => ({ render: () => h('main', { style: 'padding:32px' }, [h('h1', 'Loaded task pages'), h(Pagination, { page: { cursor: 'page-2', previous: [null], nextCursor: 'page-3', hasMore: true, loaded: true, count: 50 }, label: 'Aufträge', busy: false })]) }),
};
