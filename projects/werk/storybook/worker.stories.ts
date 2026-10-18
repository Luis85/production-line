import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { userEvent, within } from 'storybook/test';
import { h, KeepAlive, nextTick, type Component } from 'vue';
import UApp from '@nuxt/ui/components/App.vue';
import App from '../src/worker/webview/App.vue';
import WorkerShell from '../src/worker/webview/components/WorkerShell.vue';
import TaskboardPage from '../src/worker/webview/pages/TaskboardPage.vue';
import HistoryPage from '../src/worker/webview/pages/HistoryPage.vue';
import { renderMetricsPage } from './worker-metrics-fixtures';
import SettingsPage from '../src/worker/webview/pages/SettingsPage.vue';
import DurationSettingsPanel from '../src/worker/webview/components/DurationSettingsPanel.vue';
import ChatPage from '../src/worker/webview/pages/ChatPage.vue';
import TaskInteraction from '../src/worker/webview/components/TaskInteraction.vue';
import FeatureRequestNote from '../src/worker/webview/components/FeatureRequestNote.vue';
import MessageContent from '../src/worker/webview/components/MessageContent.vue';
import AssistantMessage from '../src/worker/webview/components/AssistantMessage.vue';
import NewTask from '../src/worker/webview/components/NewTask.vue';
import SettingsPanel from '../src/worker/webview/components/SettingsPanel.vue';
import DefinitionPanel from '../src/worker/webview/components/DefinitionPanel.vue';
import RequestGatePanel from '../src/worker/webview/components/RequestGatePanel.vue';
import RequestPolicyPanel from '../src/worker/webview/components/RequestPolicyPanel.vue';
import RepositoryPanel from '../src/worker/webview/components/RepositoryPanel.vue';
import StatusApp from '../src/worker/webview/status/StatusApp.vue';
import { diagnosticFixture, formattedReplyFixture, installWorkerFixture, type WorkerFixture } from './worker-fixtures';

const meta = { title: 'Worker/Workspace', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
const source = (path: string) => 'src/worker/webview/' + path + '.vue';
const links = [
  { path: '/taskboard', label: 'Taskboard', icon: 'i-lucide-columns-2' },
  { path: '/dashboard', label: 'Metrics', icon: 'i-lucide-activity' },
  { path: '/history', label: 'History', icon: 'i-lucide-history' },
  { path: '/settings', label: 'Settings', icon: 'i-lucide-settings-2' },
];
const storymap = (summary: string, covers: string[], route = '/taskboard', step?: number) => ({ app: 'Worker', summary, covers: covers.map(source), route, ready: '[data-worker-story-ready]', ...(step ? { journey: 'Give work to a worker, steer it, and review its evidence', step } : {}) });
function renderPage(component: Component, variant: WorkerFixture = 'populated') {
  return () => ({ setup() {
    installWorkerFixture(variant);
    return () => h(UApp, null, { default: () => h(WorkerShell, { links, homePath: '/taskboard', homeLabel: 'Werk worker home', navLabel: 'Worker pages' }, {
      identity: () => h('div', { class: 'worker-identity' }, [h('div', [h('strong', 'Werk release'), h('span', 'Worker storybook · example data')])]),
      status: () => h('span', { class: 'muted' }, 'Isolated example · no model connected'),
      default: () => h(KeepAlive, null, { default: () => h(component) }),
      footer: () => 'Illustrative fixture · saved tasks and model evidence',
    }) });
  } });
}
function renderComponent(component: Component, variant: WorkerFixture = 'populated', props = {}) {
  return () => ({ setup() {
    installWorkerFixture(variant);
    return () => h(UApp, null, { default: () => h('div', { style: 'max-width:1100px;margin:auto;padding:24px;min-width:0' }, [h(KeepAlive, null, { default: () => h(component, props) })]) });
  } });
}
async function element(canvas: HTMLElement, selector: string) {
  for (let n = 0; n < 100; n++) {
    const result = canvas.querySelector<HTMLElement>(selector);
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Worker story did not render ' + selector);
}
async function ready(canvas: HTMLElement) {
  await nextTick();
  canvas.setAttribute('data-worker-story-ready', 'true');
}
const settled = async ({ canvasElement }: { canvasElement: HTMLElement }) => ready(canvasElement);
const followUp = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  (await element(canvasElement, '#followup-task-tab')).click();
  await element(canvasElement, '#chat-message');
  await ready(canvasElement);
};
const boardCovers = ['components/WorkerShell', 'pages/TaskboardPage', 'components/WorkerCapacityPanel', 'components/OverviewTaskCard', 'components/TaskInteraction', 'components/TaskIntake'];

export const LockedWorkspace: Story = {
  name: '01 · Unlock the worker',
  parameters: { storymap: storymap('The workspace starts behind its access screen. No task or provider data is shown before unlocking.', ['App'], '/taskboard', 1) },
  render: renderComponent(App, 'locked'), play: settled,
};
export const EmptyTaskboard: Story = {
  name: '02 · First task and empty board',
  parameters: { storymap: storymap('An empty board explains where questions, queued work and results will appear. One composer creates a feature request with a persistent Markdown progress record.', boardCovers.filter(item => item !== 'components/OverviewTaskCard'), '/taskboard', 2) },
  render: renderPage(TaskboardPage, 'empty'), play: settled,
};
export const PopulatedTaskboard: Story = {
  name: '03 · Taskboard with mixed work',
  parameters: { storymap: storymap('Needs you, Up next, drafts and completed work aggregate saved conversations, file patches and project requests.', boardCovers, '/taskboard', 3) },
  render: renderPage(TaskboardPage), play: settled,
};
export const RunningTask: Story = {
  name: '04 · Monitor the selected model attempt',
  parameters: { storymap: storymap('The running strip records the actual attempt model and its usage. Stop task applies to that current attempt; a follow-up can be drafted while it runs.', ['components/WorkerShell', 'pages/TaskboardPage', 'components/OverviewTaskCard', 'components/TaskInteraction', 'components/MessageContent'], '/taskboard', 4) },
  render: renderPage(TaskboardPage, 'running'), play: followUp,
};
export const AnswerCheckpoint: Story = {
  name: '05 · Answer a saved checkpoint',
  parameters: { storymap: storymap('A saved model question keeps its choices and context visible. Selecting a choice fills an answer without sending it.', ['components/WorkerShell', 'pages/TaskboardPage', 'components/OverviewTaskCard', 'components/TaskInteraction', 'components/InteractionPanel', 'components/MessageContent'], '/taskboard', 5) },
  render: renderPage(TaskboardPage, 'checkpoint'),
  play: async context => { await followUp(context); await element(context.canvasElement, '#checkpoint-answer'); await ready(context.canvasElement); },
};
export const FollowUp: Story = {
  name: '06 · Follow up on a completed task',
  parameters: { storymap: storymap('Follow-up retains the selected feature request, transcript and Markdown record. It does not create unrelated work or infer the model from new provider defaults.', ['components/TaskInteraction', 'components/MessageContent'], '/taskboard', 6) },
  render: renderComponent(TaskInteraction, 'formatted'), play: followUp,
};
export const FailedAttempt: Story = {
  name: '07 · Inspect and continue a failed attempt',
  parameters: { storymap: storymap('A failed attempt exposes saved execution evidence and an explicit continuation while preserving earlier results.', ['components/TaskInteraction', 'components/InteractionPanel', 'components/MessageContent'], '/taskboard', 7) },
  render: renderComponent(TaskInteraction, 'failed'),
  play: async context => { await followUp(context); await element(context.canvasElement, '#checkpoint-answer'); await ready(context.canvasElement); },
};
export const FileTaskIntake: Story = {
  name: '08 · Add repository files to the same request',
  parameters: { storymap: storymap('One set of instructions creates a Markdown feature request. Optional approved repository files extend that request; the worker produces a patch for human review without changing the original checkout.', ['components/TaskInteraction', 'components/TaskIntake', 'components/RunTask'], '/taskboard', 8) },
  render: renderComponent(TaskInteraction),
  play: async ({ canvasElement }) => {
    const input = await element(canvasElement, '#new-task-instructions') as HTMLTextAreaElement;
    input.value = 'Clarify the task interaction guidance in README.md.'; input.dispatchEvent(new Event('input', { bubbles: true }));
    (await element(canvasElement, '.repository-options > summary')).click();
    const checkbox = await element(canvasElement, '#request-file-changes') as HTMLInputElement;
    if (!checkbox.checked) checkbox.click();
    const repository = await element(canvasElement, '#local-repository');
    await userEvent.click(repository);
    await element(document.body, '[role="option"]');
    await userEvent.click(within(document.body).getByRole('option', { name: /^web$/ }));
    const checkout = await element(canvasElement, '#file-task-checkout');
    if (!checkout.textContent?.includes('/example/projects/web')) throw Error('The request must retain the explicitly selected repository.');
    const paths = await element(canvasElement, '#local-paths') as HTMLTextAreaElement;
    paths.value = 'README.md'; paths.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    if (canvasElement.querySelectorAll('#new-task-instructions').length !== 1 || canvasElement.querySelector('#file-task-instruction')) throw Error('File scope must share the request instructions.');
    const submit = canvasElement.querySelector<HTMLButtonElement>('.task-intake button[type="submit"]');
    if (!submit?.textContent?.includes('Create request') || submit.disabled) throw Error('One request submission must include the approved file scope.');
    await ready(canvasElement);
  },
};
export const ReviewFilePatch: Story = {
  name: '09 · Review the proposed patch',
  parameters: { storymap: storymap('History links directly to one retained file patch, its approved scope and human review controls.', ['components/WorkerShell', 'pages/HistoryPage', 'components/Taskboard'], '/history?fileState=review&fileId=file-review', 9) },
  render: renderPage(HistoryPage),
  play: async ({ canvasElement }) => { await element(canvasElement, '#local-task-detail'); await ready(canvasElement); },
};
export const TaskHistory: Story = {
  name: '10 · Find saved work',
  parameters: { storymap: storymap('Task history distinguishes conversations, approved-file tasks and original orchestrator attempts, with filters for type and lifecycle.', ['components/WorkerShell', 'pages/HistoryPage', 'components/Taskboard', 'components/TaskConversationHistory'], '/history', 10) },
  render: renderPage(HistoryPage), play: settled,
};
export const ExecutionEvidence: Story = {
  name: '11 · Inspect an execution evidence pair',
  parameters: { storymap: storymap('Each attempt exposes the recorded model, before/after resources, timing and measured token coverage. Missing monetary cost is explicitly unavailable.', ['components/WorkerShell', 'pages/HistoryPage', 'components/RunEvidencePanel'], '/history?view=runs&runId=run-completed', 11) },
  render: renderPage(HistoryPage),
  play: async ({ canvasElement }) => { await element(canvasElement, '#run-detail-title'); await ready(canvasElement); },
};
export const EvidenceUnavailable: Story = {
  name: '12 · Evidence refresh failure',
  parameters: { storymap: storymap('A failed evidence read explains what could not be refreshed and keeps retry controls visible without claiming stale values are current.', ['components/WorkerShell', 'pages/HistoryPage', 'components/RunEvidencePanel'], '/history?view=runs') },
  render: renderPage(HistoryPage, 'history-error'),
  play: async ({ canvasElement }) => { await element(canvasElement, '.run-evidence [role="alert"]'); await ready(canvasElement); },
};
export const WorkerDashboard: Story = {
  name: '13 · Review consumption and worker health',
  parameters: { storymap: storymap('Metrics identifies this worker, explains its current capacity, visualizes measured and reserved consumption, and separates current process resources from retained execution outcomes. All values are fictional examples.', ['components/WorkerShell', 'pages/MonitoringPage', 'components/MetricsConsumptionPanel', 'components/MetricsResourcesPanel', 'components/MetricsExecutionPanel', 'components/ResourceMonitorPanel'], '/dashboard', 12) },
  render: renderMetricsPage(),
  play: async ({ canvasElement }) => { await element(canvasElement, '#consumption-limits'); await element(canvasElement, '[data-resource="cpu"] meter'); await element(canvasElement, '[data-execution-metric="duration"]'); await ready(canvasElement); },
};
export const ModelControls: Story = {
  name: '14 · Configure model connections and gate policy',
  parameters: { storymap: storymap('Provider configuration and request policy remain explicit controls. Credential inputs start empty, and the examples never contact a provider.', ['components/SettingsPanel', 'components/RequestPolicyPanel'], '/settings#provider-connections') },
  render: () => ({ setup() { installWorkerFixture(); return () => h(UApp, null, { default: () => h('div', { style: 'max-width:1100px;margin:auto;padding:24px' }, [h(SettingsPanel), h(RequestPolicyPanel)]) }); } }),
  play: async ({ canvasElement }) => { const input = await element(canvasElement, '#request-policy-json'); const disclosure = input.closest('details'); if (disclosure) disclosure.open = true; await ready(canvasElement); },
};
export const AgentDefinitions: Story = {
  name: '15 · Inspect imported agent definitions',
  parameters: { storymap: storymap('Imported instructions and model settings are selectable per task. Unsupported tools and delegation require an explicit instructions-only decision.', ['components/DefinitionPanel'], '/settings#agent-definitions') },
  render: renderComponent(DefinitionPanel),
  play: async ({ canvasElement }) => {
    const name = await element(canvasElement, '#definition-name') as HTMLInputElement;
    name.value = 'Release reviewer'; name.dispatchEvent(new Event('input', { bubbles: true }));
    const yaml = await element(canvasElement, '#definition-yaml') as HTMLTextAreaElement;
    yaml.value = 'agents:\n  root:\n    model: openai/gpt-fixture\n    instruction: Review acceptance criteria before proposing work.\n    toolsets:\n      - type: filesystem'; yaml.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    canvasElement.querySelector<HTMLFormElement>('form')!.requestSubmit();
    await element(canvasElement, '.definition-preview'); await ready(canvasElement);
  },
};
export const RequestReview: Story = {
  name: '16 · Review readiness, findings and rework',
  parameters: { storymap: storymap('Request lifecycle is separate from a model result. Open findings, readiness evidence, rework ownership and acceptance remain visible for human steering.', ['components/RequestGatePanel', 'components/RequestGateEvidence', 'components/MessageContent'], '/taskboard') },
  render: renderComponent(RequestGatePanel, 'populated', { requestId: 'request-review' }),
  play: async ({ canvasElement }) => { await element(canvasElement, '#request-gate-title'); await ready(canvasElement); },
};
export const ResourcePolicy: Story = {
  name: '17 · Set warning and maximum duration',
  parameters: { storymap: storymap('Warning duration and maximum attempt duration are separate settings. The form preserves drafts and explains the effect on new attempts.', ['components/DurationSettingsPanel'], '/settings#queue') },
  render: renderComponent(DurationSettingsPanel, 'running'),
  play: async ({ canvasElement }) => { await element(canvasElement, '#duration-settings-title'); await ready(canvasElement); },
};
export const ProjectRequests: Story = {
  name: '18 · Inspect a project request',
  parameters: { storymap: storymap('Project request files retain their own lifecycle and revision. A draft request has not been admitted to execution.', ['components/WorkerShell', 'pages/HistoryPage', 'components/FeatureRequestsPanel'], '/history?view=features') },
  render: renderPage(HistoryPage),
  play: async ({ canvasElement }) => { (await element(canvasElement, '[aria-label="Inspect request release-notes.md"]')).click(); await element(canvasElement, '#feature-detail-title'); await ready(canvasElement); },
};
export const LegacyConversation: Story = {
  name: '19 · Retained conversation component',
  parameters: { storymap: storymap('The legacy conversation component remains documented for source compatibility; the public /chat route redirects to Taskboard.', ['components/WorkerShell', 'pages/ChatPage', 'components/SessionPanel', 'components/MessageContent', 'components/RequestGatePanel'], '/taskboard') },
  render: renderPage(ChatPage),
  play: async ({ canvasElement }) => { await element(canvasElement, '#chat-task-title'); await element(canvasElement, '#request-gate-title'); await ready(canvasElement); },
};
export const DraftTask: Story = {
  name: '20 · Create a named draft task',
  parameters: { storymap: storymap('The retained draft-task component chooses a connection, optional agent definition and name without sending a model request.', ['components/NewTask'], '/taskboard') },
  render: renderComponent(NewTask), play: settled,
};
export const DiagnosticExport: Story = {
  name: '21 · Read an offline status export',
  parameters: { storymap: storymap('The standalone status export reports its capture time, simulated mode and process-level counters without polling a live worker.', ['status/StatusApp'], '/dashboard') },
  render: () => ({ setup() { installWorkerFixture(); return () => h(StatusApp, { initial: diagnosticFixture }); } }), play: settled,
};
export const OriginalAssignmentEvidence: Story = {
  name: '22 · Inspect an original orchestrator assignment',
  parameters: { storymap: storymap('Original remote assignments keep their own journal snapshots. Simulated attempts remain explicitly distinct from implemented changes and human-reviewed patches.', ['components/WorkerShell', 'pages/HistoryPage', 'components/Taskboard'], '/history') },
  render: renderPage(HistoryPage),
  play: async ({ canvasElement }) => { (await element(canvasElement, '[data-attempt="pair-simulated"]')).click(); await element(canvasElement, '#evidence-title'); await ready(canvasElement); },
};

export const RepositoryAssignments: Story = {
  name: '23 · Assign and watch Git repositories',
  parameters: { storymap: storymap('Assigned checkouts show safe synchronization status. Local changes remain visible, and queued work prevents replacing repository assignments.', ['components/RepositoryPanel'], '/settings#repositories') },
  render: renderComponent(RepositoryPanel),
  play: async ({ canvasElement }) => {
    (await element(canvasElement, '.repository-editor') as HTMLDetailsElement).open = true;
    await element(canvasElement, '#repository-id-0'); await ready(canvasElement);
  },
};

export const RepositoryConsent: Story = {
  name: '24 · Choose the detected repository',
  parameters: { storymap: storymap('The first unlocked taskboard asks before adding its local Git checkout. The full path, watching permission and a durable decline are visible without blocking tasks.', ['components/WorkerShell', 'pages/TaskboardPage', 'components/RepositoryDiscovery'], '/taskboard') },
  render: renderPage(TaskboardPage, 'repository-pending'), play: settled,
};
export const ReconsiderRepository: Story = {
  name: '25 · Reconsider a skipped repository',
  parameters: { storymap: storymap('A skipped installation checkout stays available in Settings. Declining does not create an assignment or start watching it.', ['components/RepositoryPanel', 'components/RepositoryDiscovery'], '/settings#repositories') },
  render: renderComponent(RepositoryPanel, 'repository-declined'), play: settled,
};
export const LocalRepositoryConsent: Story = {
  name: '26 · Use a local repository without a remote',
  parameters: { storymap: storymap('A local checkout can be assigned for file tasks while watching remains off. Adding a remote and enabling watching is a later operator choice.', ['components/RepositoryPanel', 'components/RepositoryDiscovery'], '/settings#repositories') },
  render: renderComponent(RepositoryPanel, 'repository-local'), play: settled,
};

export const FormattedModelReply: Story = {
  name: '27 · Read a formatted model reply',
  parameters: { storymap: storymap('A synthetic completed reply demonstrates readable headings, nested lists, quoted guidance, a scrollable evidence table, copyable code and a safe documentation link. The transcript is example data, not verification evidence.', ['components/MessageContent'], '/taskboard') },
  render: renderComponent(MessageContent, 'formatted', { text: formattedReplyFixture }),
  play: async ({ canvasElement }) => {
    const message = await element(canvasElement, '.message-content.markdown');
    const assertText = async (selector: string, expected: string) => {
      const rendered = await element(message, selector);
      if (!rendered.textContent?.includes(expected)) throw Error('Formatted reply lost ' + selector + ' content');
      return rendered;
    };
    await assertText('h3', 'Release review');
    await assertText('h4', 'Next steps');
    await assertText('em', 'Illustrative fixture');
    await assertText('strong', 'saved patch');
    await assertText('ol > li', 'Inspect the proposed documentation change.');
    await assertText('ol > li > ul > li', 'Confirm the task instructions are clear.');
    await assertText('blockquote', 'does not prove that tests ran');
    const table = await element(message, '.markdown-table-scroll[role="region"][tabindex="0"] table');
    if (table.querySelectorAll('thead th[scope="col"]').length !== 3 || table.querySelectorAll('tbody tr').length !== 3) throw Error('Formatted reply evidence table lost its headers or rows');
    const code = await element(message, 'pre[tabindex="0"] > code');
    if (code.textContent?.trim() !== 'const nextStep = "Review the saved patch";') throw Error('Formatted reply changed its code example');
    await assertText('.code-toolbar button', 'Copy code');
    const link = await element(message, 'a') as HTMLAnchorElement;
    if (link.href !== 'https://github.com/Luis85/production-line/blob/main/projects/werk/docs/how-to/use-worker-webview.md' || link.target !== '_blank' || !link.relList.contains('noopener') || !link.relList.contains('noreferrer')) throw Error('Formatted reply documentation link lost its destination or safe navigation attributes');
    await ready(canvasElement);
  },
};


export const WorkerSettings: Story = {
  name: '28 · Configure providers and accounts',
  parameters: { storymap: storymap('Settings gives each configuration area its own destination. Provider sign-in is illustrative; no account or model is contacted.', ['components/WorkerShell', 'pages/SettingsPage', 'components/SettingsPanel'], '/settings#provider-connections', 13) },
  render: renderPage(SettingsPage, 'settings-ready'),
  play: async ({ canvasElement }) => { await element(canvasElement, '#provider-path'); await ready(canvasElement); },
};
export const QueueAndDurationSettings: Story = {
  name: '29 · Configure queue and duration',
  parameters: { storymap: storymap('Queue admission is separate from the single execution slot. Warning and maximum duration have explicit independent save controls.', ['components/WorkerShell', 'pages/SettingsPage', 'components/QueueSettingsPanel', 'components/DurationSettingsPanel'], '/settings#queue') },
  render: renderPage(SettingsPage, 'settings-ready'),
  play: async ({ canvasElement }) => { await element(canvasElement, '#queue-settings-title'); await element(canvasElement, '#duration-settings-title'); await ready(canvasElement); },
};
export const ToolAccessSettings: Story = {
  name: '30 · Configure tools and MCP',
  parameters: { storymap: storymap('Tool permissions and MCP connections have a dedicated Settings section. This paused, empty fixture can edit configuration; runtime writes are disabled in Storybook.', ['components/WorkerShell', 'pages/SettingsPage', 'components/ToolAccessPanel', 'components/McpConnectionsEditor'], '/settings#tool-access') },
  render: renderPage(SettingsPage, 'settings-ready'), play: settled,
};
export const ProjectIntegrationSettings: Story = {
  name: '31 · Inspect project integration files',
  parameters: { storymap: storymap('Project authoring files live in their own Settings section. The fixture displays a current integration without writing project files.', ['components/WorkerShell', 'pages/SettingsPage', 'components/ProjectIntegrationsPanel'], '/settings#integrations') },
  render: renderPage(SettingsPage, 'settings-ready'),
  play: async ({ canvasElement }) => { await element(canvasElement, '#integrations-title'); await ready(canvasElement); },
};
export const FullLocalCapacity: Story = {
  name: '32 · Keep a draft while local admission is full',
  parameters: { storymap: storymap('One active task plus two queued tasks fills three local admission places. The execution slot remains one, and new instructions cannot be submitted until space is free.', boardCovers, '/taskboard') },
  render: renderPage(TaskboardPage, 'capacity-full'),
  play: async ({ canvasElement }) => {
    const input = await element(canvasElement, '#new-task-instructions') as HTMLTextAreaElement;
    input.value = 'Prepare a follow-up release checklist when capacity is available.'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    const submit = canvasElement.querySelector<HTMLButtonElement>('.task-intake button[type="submit"]');
    if (!submit?.disabled) throw Error('Full-capacity fixture must keep new task submission disabled.');
    await ready(canvasElement);
  },
};
export const ConsumptionBlockedCapacity: Story = {
  name: '33 · Distinguish admission from blocked starts',
  parameters: { storymap: storymap('Queued tasks use two local places while an exhausted allowance blocks new model calls. Admission can remain available without promising an immediate start.', boardCovers, '/taskboard') },
  render: renderPage(TaskboardPage, 'capacity-blocked'), play: settled,
};
export const StaleWorkerCapacity: Story = {
  name: '34 · Recognize stale activity',
  parameters: { storymap: storymap('Last reported execution and admission values remain visible with a refresh action. Stale data does not claim the worker is available or blocked.', boardCovers, '/taskboard') },
  render: renderPage(TaskboardPage, 'capacity-stale'), play: settled,
};
export const PausedWorkerCapacity: Story = {
  name: '35 · Keep accepted work while starts are paused',
  parameters: { storymap: storymap('A manual pause keeps two accepted tasks queued. Local admission and execution occupancy stay separate from the pause state.', boardCovers, '/taskboard') },
  render: renderPage(TaskboardPage, 'capacity-paused'), play: settled,
};

function renderRequestNote(variant: WorkerFixture = 'populated') {
  return () => ({ setup() {
    const { state } = installWorkerFixture(variant);
    return () => h(UApp, null, { default: () => h('div', { style: 'max-width:900px;margin:auto;padding:24px;min-width:0' }, [
      h('p', { class: 'muted' }, 'Illustrative feature request record · no runtime writes or model calls'),
      h(FeatureRequestNote, { session: state.sessions!.records.find(item => item.id === state.sessions!.selected)! }),
    ]) });
  } });
}
async function openRequestNote(canvas: HTMLElement) {
  (await element(canvas, '#feature-request-note details > summary')).click();
  return element(canvas, '#feature-request-note .message-content.markdown');
}
export const SavedFeatureRequest: Story = {
  name: '36 · Read a saved feature request',
  parameters: { storymap: storymap('The selected request exposes its saved Markdown filename, location and timestamp. A readable disclosure and download keep progress and proposed results accessible without presenting model output as verified work.', ['components/FeatureRequestNote', 'components/MessageContent']) },
  render: renderRequestNote(),
  play: async ({ canvasElement }) => {
    const markdown = await openRequestNote(canvasElement);
    if (!markdown.textContent?.includes('Progress') || !markdown.textContent?.includes('Results')) throw Error('The saved request must expose progress and results.');
    await ready(canvasElement);
  },
};
export const FeatureRequestCheckpoint: Story = {
  name: '37 · Keep a question in the request record',
  parameters: { storymap: storymap('A request waiting for input keeps its question and choices in the same saved Markdown record. The example has no final result while that decision is open.', ['components/FeatureRequestNote', 'components/MessageContent']) },
  render: renderRequestNote('checkpoint'),
  play: async ({ canvasElement }) => {
    const markdown = await openRequestNote(canvasElement);
    if (!markdown.textContent?.includes('Which delivery format') || !markdown.textContent?.includes('No final result')) throw Error('The waiting request must retain its unresolved question without a final result.');
    await ready(canvasElement);
  },
};
export const FeatureRequestReadFailure: Story = {
  name: '38 · Recover an unavailable note read',
  parameters: { storymap: storymap('A failed Markdown read preserves the last saved filename and location, explains the failure, and offers a deliberate retry. It does not silently display stale note content.', ['components/FeatureRequestNote']) },
  render: renderRequestNote('tracking-read-error'),
  play: async ({ canvasElement }) => {
    (await element(canvasElement, '#feature-request-note details > summary')).click();
    await element(canvasElement, '#feature-request-note [role="alert"]');
    await element(canvasElement, '.feature-request-filename');
    await ready(canvasElement);
  },
};
export const FeatureRequestSaveFailure: Story = {
  name: '39 · Make a missing progress record visible',
  parameters: { storymap: storymap('A journaled task whose Markdown projection could not be saved stays visible with a clear save error and refresh action. The interface does not claim a saved note or encourage duplicate task submission.', ['components/FeatureRequestNote']) },
  render: renderRequestNote('tracking-save-error'),
  play: async ({ canvasElement }) => { await element(canvasElement, '#feature-request-note .error-text[role="status"]'); await ready(canvasElement); },
};

export const InterruptedRequestPreparation: Story = {
  name: '40 · Recover a request with a changed worktree',
  parameters: { storymap: storymap('Interrupted file preparation retains its request and changed worktree for inspection. Without accepted file snapshots, the worker requires a new request and offers no resume, retry or follow-up on the failed admission.', ['components/WorkerShell', 'pages/TaskboardPage', 'components/TaskInteraction', 'components/FeatureRequestNote'], '/taskboard') },
  render: renderPage(TaskboardPage, 'admission-failed'),
  play: async context => {
    (await element(context.canvasElement, '#followup-task-tab')).click();
    const recovery = await element(context.canvasElement, '.admission-recovery[aria-label="Request recovery"]');
    if (!recovery.textContent?.includes('/example/.werk/worker/worktrees/file-review')) throw Error('The preserved worktree must remain available for inspection.');
    if (![...recovery.querySelectorAll('button')].some(button => button.textContent?.includes('New request'))) throw Error('Recovery must offer a new request.');
    if (context.canvasElement.querySelector('.followup-composer, .task-checkpoint, .request-controls, .composer-jump')) throw Error('A failed admission must not offer continuation without approved snapshots.');
    await ready(context.canvasElement);
  },
};

export const FileTaskReply: Story = {
  name: '40 · Read a file-task result',
  parameters: { storymap: storymap('A saved file-task change set reads as its summary and a changed-file list. Paths and globs stay literal, file contents stay in the patch view, and the stored model output remains available, collapsed.', ['components/TaskInteraction', 'components/AssistantMessage', 'components/MessageContent'], '/taskboard') },
  render: renderComponent(TaskInteraction, 'file-reply'),
  play: async context => {
    await followUp(context);
    const message = await element(context.canvasElement, '.assistant-message');
    if (!message.querySelector('code')?.textContent?.includes('**/*.spec.ts')) throw Error('File-task reply lost its literal glob');
    if (message.querySelector('.message-content')?.textContent?.includes('"files"')) throw Error('File-task reply shows raw protocol JSON');
    if (!message.querySelector('.patch-review-link') || !message.querySelector('.raw-output')) throw Error('File-task reply lost its patch link or raw output');
    await ready(context.canvasElement);
  },
};

export const JsonExampleReply: Story = {
  name: '41 · Read a JSON example without artifact claims',
  parameters: { storymap: storymap('An ordinary JSON example remains a code block. Its property names cannot claim a saved patch or create a checkpoint.', ['components/AssistantMessage', 'components/MessageContent'], '/taskboard') },
  render: renderComponent(AssistantMessage, 'formatted', { text: JSON.stringify({ summary: 'Example schema, not executed work.', files: [{ path: 'example.json', content: 'Example content' }] }) }),
  play: async ({ canvasElement }) => {
    const message = await element(canvasElement, '.assistant-message');
    await element(message, 'pre code');
    if (!message.textContent?.includes('Example content') || message.textContent?.includes('patch is saved') || message.querySelector('.patch-review-link, .raw-output')) throw Error('Ordinary JSON acquired task artifact claims.');
    await ready(canvasElement);
  },
};
