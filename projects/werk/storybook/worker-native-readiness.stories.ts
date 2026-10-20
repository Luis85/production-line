import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { userEvent, within } from 'storybook/test';
import { computed, h, nextTick } from 'vue';
import UApp from '@nuxt/ui/components/App.vue';
import RepositoryPanel from '../src/worker/webview/components/RepositoryPanel.vue';
import WorkerCapacityPanel from '../src/worker/webview/components/WorkerCapacityPanel.vue';
import TaskIntake from '../src/worker/webview/components/TaskIntake.vue';
import { state } from '../src/worker/webview/store';
import { buildWorkerCapacityView } from '../src/worker/webview/worker-capacity';
import { installWorkerFixture } from './worker-fixtures';

const meta = { title: 'Worker/Native readiness', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
const storymap = (summary: string) => ({ app: 'Worker', summary, covers: ['RepositoryPanel', 'RepositoryDiscovery', 'WorkerCapacityPanel', 'TaskIntake'].map(name => 'src/worker/webview/components/' + name + '.vue'), route: '/settings#repositories', ready: '[data-native-readiness-ready]' });
function render() {
  return { setup() {
    installWorkerFixture('empty');
    state.settings!.repositories.items = [{ id: 'web', path: '/example/projects/web', remote: 'origin', branch: 'main', watch: true }];
    state.environment!.repositories.nativeWork = { state: 'preparing', message: null };
    const capacity = computed(() => buildWorkerCapacityView(state.sessions!.capacity, 'fresh', state.environment!.repositories.nativeWork));
    return () => h(UApp, null, { default: () => h('div', { style: 'max-width:1050px;margin:auto;padding:24px;min-width:0' }, [
      h('p', { class: 'page-note' }, 'Illustrative startup transition · no Git, model or native command execution'),
      h(WorkerCapacityPanel, { view: capacity.value }), h(RepositoryPanel), h(TaskIntake),
    ]) });
  } };
}
async function prepareDraft(canvas: HTMLElement) {
  const query = within(canvas);
  await userEvent.click(query.getByText('Manage repository assignments', { exact: true }));
  const branch = query.getByLabelText('Branch · optional') as HTMLInputElement;
  await userEvent.clear(branch); await userEvent.type(branch, 'draft-branch');
  const instructions = query.getByLabelText('Request instructions', { exact: true }) as HTMLTextAreaElement;
  await userEvent.type(instructions, 'Document the deployment checklist.');
  const save = query.getByRole('button', { name: 'Save assignments' }) as HTMLButtonElement;
  const sync = query.getByRole('button', { name: 'Check & pull' }) as HTMLButtonElement;
  const create = query.getByRole('button', { name: 'Create request' }) as HTMLButtonElement;
  if (!save.disabled || !sync.disabled || branch.disabled || instructions.disabled || create.disabled) throw Error('Startup must block native repository changes while drafts and durable intake stay usable.');
  if (!canvas.querySelector('.worker-capacity [aria-live="polite"]')?.textContent?.includes('Saved requests remain queued')) throw Error('Queue readiness must explain the pending native runtime.');
  return { branch, instructions, save, sync, create };
}
export const Preparing: Story = {
  parameters: { storymap: storymap('Native preparation visibly holds repository checks and assignment saves while request intake and editable drafts remain available.') },
  render,
  play: async ({ canvasElement }) => { await prepareDraft(canvasElement); canvasElement.setAttribute('data-native-readiness-ready', 'true'); },
};
export const ReadyAfterPreparation: Story = {
  parameters: { storymap: storymap('Preparing → synchronizing → ready re-enables repository controls without losing input focus or drafts, resuming a saved manual pause, or blocking durable request intake.') },
  render,
  play: async ({ canvasElement }) => {
    const { branch, instructions, save, sync, create } = await prepareDraft(canvasElement);
    state.environment!.repositories.nativeWork = { state: 'starting', message: null }; await nextTick();
    if (!save.disabled || !sync.disabled || !canvasElement.querySelector('.worker-capacity [aria-live="polite"]')?.textContent?.includes('Synchronizing assigned repositories')) throw Error('Synchronization must retain the native hold and explain its current phase.');
    state.settings!.board.paused = true; state.sessions!.capacity!.starts.paused = true;
    state.environment!.repositories.nativeWork = { state: 'ready', message: null }; await nextTick();
    if (save.disabled || sync.disabled || create.disabled || branch.value !== 'draft-branch' || instructions.value !== 'Document the deployment checklist.' || document.activeElement !== instructions) throw Error('Ready must restore guarded actions while preserving the draft and focus.');
    if (canvasElement.querySelector('.worker-capacity [aria-live="polite"]') || !canvasElement.querySelector('#worker-capacity-title')?.textContent?.includes('New starts paused') || !state.settings!.board.paused) throw Error('Native readiness must remove its notice without resuming saved manual pause.');
    canvasElement.setAttribute('data-native-readiness-ready', 'true');
  },
};
