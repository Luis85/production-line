import type { WorkerInteractionResponse } from '../src/shared/worker-interaction';
import type { LineSubmissionReceipt } from '../src/shared/webview/line-interaction';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { nextTick, ref } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import AccessPanel from '../src/shared/webview/components/AccessPanel.vue';
import AsyncState from '../src/shared/webview/components/AsyncState.vue';
import ConnectionStatus from '../src/shared/webview/components/ConnectionStatus.vue';
import PageHeading from '../src/shared/webview/components/PageHeading.vue';
import StatCard from '../src/shared/webview/components/StatCard.vue';
import TaskKanban from '../src/shared/webview/components/TaskKanban.vue';
import SpatialMap from '../src/shared/webview/components/SpatialMap.vue';
import OnboardingTour from '../src/shared/webview/components/OnboardingTour.vue';
import LineInteractionPanel from '../src/shared/webview/components/LineInteractionPanel.vue';
import MessageContent from '../src/shared/webview/components/MessageContent.vue';
import { formattedReplyFixture } from './worker-fixtures';
import WerkShell from '../src/shared/webview/components/WerkShell.vue';
import type { KanbanColumn, KanbanTask } from '../src/shared/webview/task-kanban';
import type { SpatialNode } from '../src/shared/webview/types';
import { clickButton, fillInput, findElement } from './story-actions';

const meta = { title: 'Shared/Interface elements', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const shared = (summary: string, component: string) => ({ storymap: {
  app: 'Shared', styles: [component === 'LineInteractionPanel' ? 'src/factory/webview/style.css' : 'src/worker/webview/style.css'], summary, covers: [`src/shared/webview/components/${component}.vue`],
  journey: 'Understand and operate the interface',
} });

export const Access: Story = {
  parameters: shared('Unlock a runtime with its own token; token discovery and privacy guidance remain available.', 'AccessPanel'),
  render: () => ({ components: { AccessPanel, UButton, UInput }, template: `
    <AccessPanel title="Unlock this worker" lead="Use this worker’s access token to continue." caption="Worker access is separate from Factory and line administration.">
      <form @submit.prevent><label for="story-token">Access token</label><div class="access-input"><UInput id="story-token" class="grow" type="password" autocomplete="off" placeholder="Enter worker token" /></div><UButton class="unlock-submit" type="submit">Unlock worker</UButton></form>
      <template #help><p>Find the token in the private configuration created by your launcher.</p></template>
      <template #privacy>Your token stays out of browser URLs and shared logs.</template>
    </AccessPanel>` }),
};
export const Loading: Story = {
  parameters: shared('Show a loading announcement while the current scope is being fetched.', 'AsyncState'),
  render: () => ({ components: { AsyncState }, template: '<main style="padding:32px"><AsyncState loading /></main>' }),
};
export const Unavailable: Story = {
  parameters: shared('An unavailable observation stays unknown and exposes a useful recovery explanation.', 'AsyncState'),
  render: () => ({ components: { AsyncState }, template: '<main style="padding:32px"><AsyncState error="The line could not be reached. Check its process and reconnect before taking action." /></main>' }),
};
export const Empty: Story = {
  parameters: shared('Explain an empty task scope and give the operator a next action.', 'AsyncState'),
  render: () => ({ components: { AsyncState, UButton }, template: '<main style="padding:32px"><AsyncState empty empty-title="No tasks in this line" empty-description="Submit a requirement or a task to begin."><template #emptyAction><UButton>Create a task</UButton></template></AsyncState></main>' }),
};
export const HealthyConnection: Story = {
  parameters: shared('Identify a healthy connection and its observation scope.', 'ConnectionStatus'),
  render: () => ({ components: { ConnectionStatus }, template: '<main style="padding:32px"><ConnectionStatus healthy label="Worker connected" detail="Product line · 1 of 2 slots available" /></main>' }),
};
export const UnavailableConnection: Story = {
  parameters: shared('Make an unavailable connection explicit without treating unknown capacity as zero.', 'ConnectionStatus'),
  render: () => ({ components: { ConnectionStatus }, template: '<main style="padding:32px"><ConnectionStatus label="Worker unavailable" detail="Last observation is stale · capacity unknown" /></main>' }),
};
export const Heading: Story = {
  parameters: shared('Give each view a clear title, scope description and relevant primary action.', 'PageHeading'),
  render: () => ({ components: { PageHeading, UButton }, template: '<main style="padding:32px"><PageHeading title="Taskboard" description="Follow the work in this production line."><template #eyebrow><p class="eyebrow">Product line</p></template><template #actions><UButton>Create task</UButton></template></PageHeading></main>' }),
};
export const Statistic: Story = {
  parameters: shared('Show a bounded operational total with the observation context next to it.', 'StatCard'),
  render: () => ({ components: { StatCard }, template: '<main style="padding:32px;max-width:440px"><StatCard :value="3" label="Tasks need attention" detail="Two review decisions and one input request in the observed line." /></main>' }),
};

const columns: KanbanColumn[] = [
  { id: 'queued', label: 'Queued', statuses: ['queued'] },
  { id: 'running', label: 'Running', statuses: ['running'] },
  { id: 'review', label: 'Needs review', statuses: ['review'] },
];
const tasks: KanbanTask[] = [
  { id: 'FT-104', title: 'Validate supplier imports', status: 'queued', sourceId: 'line-atlas', sourceLabel: 'Product line', project: 'Atlas', priority: 1, gate: { phase: 'not_evaluated' } },
  { id: 'FT-101', title: 'Explain duplicate supplier matches', status: 'running', sourceId: 'line-atlas', project: 'Atlas', workerLabel: 'Worker 02', gate: { phase: 'running', label: 'Implementing' } },
  { id: 'FT-102', title: 'Review customer export permissions', status: 'review', sourceId: 'line-atlas', project: 'Atlas', gate: { phase: 'waiting_input', label: 'Human review required' } },
];
export const Board: Story = {
  parameters: shared('Group task identity, ownership and request gates without mixing line scopes.', 'TaskKanban'),
  render: () => ({ components: { TaskKanban }, setup: () => ({ columns, tasks }), template: '<main style="padding:32px"><TaskKanban :tasks="tasks" :columns="columns" scope-label="Product line tasks" /></main>' }),
};
export const EmptyBoard: Story = {
  parameters: shared('Preserve the board structure and explain the empty state before tasks exist.', 'TaskKanban'),
  render: () => ({ components: { TaskKanban }, setup: () => ({ columns }), template: '<main style="padding:32px"><TaskKanban :tasks="[]" :columns="columns" scope-label="New production line" empty-text="No tasks have been submitted to this line." /></main>' }),
};

const nodes: SpatialNode[] = [
  { id: 'factory', label: 'Factory', kind: 'Portfolio', model: 'factory', x: 0, z: 0, color: '#81b6ee', description: 'Organizes independent production lines and observes their availability.', facts: [['Scope', 'Portfolio registration and ownership']] },
  { id: 'orchestrator', label: 'Product line', kind: 'Orchestrator', model: 'orchestrator', x: 1.8, z: 1, color: '#8be0b8', description: 'Owns task state, bounded leases and accepted evidence.', facts: [['Scope', 'One independent task store']] },
  { id: 'worker', label: 'Worker 02', kind: 'Worker', model: 'workers', x: 3.4, z: 2, color: '#edc47e', description: 'Executes eligible attempts and returns durable evidence.', facts: [['Execution', 'Illustrative simulation'], ['Capacity', 'One configured slot']] },
];
const edges = [{ from: 'factory', to: 'orchestrator' }, { from: 'orchestrator', to: 'worker' }, { from: 'worker', to: 'orchestrator', dashed: true }];
const spatialRender = () => ({ components: { SpatialMap }, setup: () => ({ nodes, edges }), template: '<main style="padding:24px"><SpatialMap :nodes="nodes" :edges="edges" selected-id="worker" label="Illustrative production topology" caption="Documentation fixture · no live connections" legend="Solid: ownership and work · Dashed: returned evidence" /></main>' });
export const SpatialTopology: Story = {
  parameters: shared('Explore the system topology and the responsibility of the selected entity.', 'SpatialMap'),
  render: spatialRender,
};
export const SpatialTopology2D: Story = {
  parameters: shared('Read the same topology in its accessible two-dimensional representation.', 'SpatialMap'),
  render: spatialRender,
  play: async ({ canvasElement }) => { await clickButton(canvasElement, '2D'); },
};

export const Shell: Story = {
  parameters: shared('Navigate between scoped runtime pages while identity and connection status remain visible.', 'WerkShell'),
  render: () => ({ components: { WerkShell, PageHeading, ConnectionStatus }, setup: () => ({ links: [
    { path: '/', label: 'Overview', icon: 'i-lucide-layout-dashboard' },
    { path: '/tasks', label: 'Tasks', icon: 'i-lucide-columns-3' },
    { path: '/workers', label: 'Workers', icon: 'i-lucide-cpu' },
  ] }), template: '<WerkShell :links="links"><template #identity><p>Product line</p></template><template #status><ConnectionStatus healthy label="Line connected" detail="Illustrative runtime" /></template><PageHeading title="Production line" description="A scoped workspace for tasks, workers and evidence." /><template #footer>Documentation fixture · no live requests</template></WerkShell>' }),
};
export const Tour: Story = {
  parameters: shared('Guide the operator through the current view with a reversible, keyboard-accessible tour.', 'OnboardingTour'),
  render: () => ({ components: { OnboardingTour, UButton }, setup() {
    const open = ref(false);
    const steps = [{ title: 'Start with the taskboard', text: 'Select a task to inspect its progress and follow up in the interaction panel.', target: '#story-tour-target' }, { title: 'Keep decisions explicit', text: 'Review the active attempt and evidence before approving the next action.' }];
    return { open, steps };
  }, template: '<main style="padding:32px"><h1 id="story-tour-target">Taskboard</h1><p>Tasks remain the starting point for worker interaction.</p><UButton @click="open=true">Start tour</UButton><OnboardingTour v-model:open="open" title="Worker tour" :steps="steps" /></main>' }),
  play: async ({ canvasElement }) => { await clickButton(canvasElement, 'Start tour'); },
};

const interactionRender = () => ({ components: { LineInteractionPanel }, setup() {
  const open = ref(true);
  const request = async (): Promise<WorkerInteractionResponse> => ({ workerId: 'story-worker', chat: { available: true, busy: false, phase: 'completed', messages: [
    { id: 'request-1', role: 'user', text: 'Add validation for duplicate supplier records.' },
    { id: 'reply-1', role: 'assistant', state: 'complete', text: '# Review ready\n\nThe **implementation** is ready for review.\n\n- Check duplicate names.\n\n| Check | Result |\n| --- | --- |\n| Matching | Review required |\n\n```js\nconst literal = "&amp; <b>exact</b>";\n```\n\n[Review guide](https://example.com/review).\n\n<img src=x onerror=alert(1)>' },
  ] }, sessions: { selected: 'story-task-104', records: [{ id: 'story-task-104', title: 'Validate supplier imports', status: 'completed' }] } });
  const submit = async (): Promise<LineSubmissionReceipt> => ({ kind: 'line', id: 'FT-107' });
  return { open, request, submit };
}, template: '<LineInteractionPanel v-model:open="open" title="Product line interaction" project="atlas" :can-write="true" :request="request" :submit="submit" />' });
export const ConnectWorker: Story = {
  parameters: shared('Explicitly connect to a worker before reading or continuing its selected task session.', 'LineInteractionPanel'),
  render: interactionRender,
};
export const FollowUp: Story = {
  parameters: shared('Continue an existing worker task with its conversation and execution controls in view.', 'LineInteractionPanel'),
  render: interactionRender,
  play: async () => {
    await fillInput(document.body, '#interaction-worker-url', 'http://127.0.0.1:4100');
    await fillInput(document.body, '#interaction-worker-token', 'documentation-fixture-only');
    await clickButton(document.body, 'Connect model session');
    await findElement(document.body, '#interaction-message');
    await findElement(document.body, '.interaction-transcript .markdown h3');
    await findElement(document.body, '.interaction-transcript table');
    await findElement(document.body, '.interaction-transcript pre[tabindex="0"]');
    if (document.querySelector('.interaction-transcript img, .interaction-transcript script, .interaction-transcript [onerror]')) throw Error('Transcript must render HTML as text.');
    await fillInput(document.body, '#interaction-message', 'Also include the case where names differ only in letter case.');
  },
};
export const SubmitLineTask: Story = {
  parameters: shared('Submit a scoped task with acceptance criteria and an explicit execution mode.', 'LineInteractionPanel'),
  render: interactionRender,
  play: async () => {
    await clickButton(document.body, 'Submit task');
    await fillInput(document.body, '#interaction-title', 'Validate supplier imports');
    await fillInput(document.body, '#interaction-criteria', 'Reject rows without a supplier name.\nFlag duplicate names for human review.');
    await nextTick();
  },
};

export const FormattedReply: Story = {
  parameters: shared('The same bounded Markdown renderer formats model replies in every application. Raw HTML remains text, images do not fetch, and code keeps its literal contents.', 'MessageContent'),
  render: () => ({ components: { MessageContent }, setup: () => ({ text: formattedReplyFixture }), template: '<main style="padding:24px;max-width:850px"><MessageContent :text="text" /></main>' }),
  play: async () => {
    await findElement(document.body, '.message-content table');
    await findElement(document.body, '.message-content pre[tabindex="0"]');
    if (document.querySelector('.message-content img, .message-content script')) throw Error('Model replies must not execute HTML or fetch images.');
  },
};
