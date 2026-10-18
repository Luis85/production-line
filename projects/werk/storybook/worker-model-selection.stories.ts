import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { userEvent, waitFor, within } from 'storybook/test';
import { h, nextTick } from 'vue';
import UApp from '@nuxt/ui/components/App.vue';
import TaskIntake from '../src/worker/webview/components/TaskIntake.vue';
import SettingsPanel from '../src/worker/webview/components/SettingsPanel.vue';
import { state } from '../src/worker/webview/store';
import { installWorkerFixture } from './worker-fixtures';
const meta = { title: 'Worker/Model selection', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
function render(settings = false, cursor = false) { return () => ({ setup() {
  installWorkerFixture(settings ? 'settings-ready' : 'empty');
  state.settings!.providers.push({ id: 'cursor-cli', label: 'Cursor CLI', executable: '/example/bin/agent', model: 'auto', effort: 'default', configured: true, hasApiKey: false, authentication: 'Illustrative local Cursor login; not checked' });
  state.settings!.providers[0].effort = 'medium';
  if (cursor) state.settings!.defaultProvider = 'cursor-cli';
  return () => h(UApp, null, { default: () => h('main', { style: 'max-width:760px;margin:auto;padding:24px;min-width:0' }, [h('p', { class: 'page-note' }, 'Illustrative example · no provider sign-in, settings write or model call'), h(settings ? SettingsPanel : TaskIntake, settings ? { providerOnly: true } : {})]) });
} }); }
const storymap = (summary: string, settings = false) => ({ app: 'Worker', summary, covers: ['src/worker/webview/components/ModelSelectionFields.vue', 'src/worker/webview/components/' + (settings ? 'SettingsPanel' : 'TaskIntake') + '.vue'], route: settings ? '/settings#provider-connections' : '/taskboard', ready: '[data-model-selection-ready]' });
async function ready(canvas: HTMLElement) { await nextTick(); canvas.setAttribute('data-model-selection-ready', 'true'); }
async function choose(canvas: HTMLElement, selector: string, label: string) {
  const control = canvas.querySelector<HTMLElement>(selector); if (!control) throw Error('Missing model selection ' + selector);
  await userEvent.click(control); await userEvent.click(await within(document.body).findByRole('option', { name: label }));
  await waitFor(() => { if (getComputedStyle(document.body).pointerEvents === 'none') throw Error('Waiting for selection menu to close.'); });
}
export const RequestOverride: Story = {
  name: 'Choose a model and effort for this Feature Request',
  parameters: { storymap: storymap('An explicit request model overrides the inherited provider or imported profile model. Effort choices follow the selected adapter, and uncertain submission retains the exact selection.') },
  render: render(),
  play: async ({ canvasElement }) => {
    const query = within(canvasElement);
    await userEvent.type(query.getByLabelText('Request instructions', { exact: true }), 'Implement the team’s export feature.');
    await userEvent.click(query.getByText('Task options', { exact: true }));
    await userEvent.type(query.getByLabelText('Model · optional', { exact: true }), 'team-model');
    await choose(canvasElement, '#new-task-effort', 'High');
    if (!canvasElement.textContent?.includes('The worker saves the resolved selection when it accepts the request.')) throw Error('Acceptance-time freeze guidance missing.');
    await ready(canvasElement);
  },
};
export const CursorRequest: Story = {
  name: 'Cursor CLI uses its native tool policy',
  parameters: { storymap: storymap('The worker default selects Cursor CLI for a new request. Its native permissions and hooks are visible, and no unsupported effort control is offered.') },
  render: render(false, true),
  play: async ({ canvasElement }) => {
    const query = within(canvasElement); await userEvent.click(query.getByText('Task options', { exact: true }));
    if (!canvasElement.textContent?.includes('Worker file, command and MCP grants do not constrain its native tools.')) throw Error('Cursor authority guidance missing.');
    await choose(canvasElement, '#new-task-effort', 'Provider default');
    if (canvasElement.textContent?.includes('Tool access: All tools off')) throw Error('Worker grants must not be presented as Cursor native constraints.');
    await ready(canvasElement);
  },
};
export const WorkerDefaults: Story = {
  name: 'Configure worker defaults without changing accepted requests',
  parameters: { storymap: storymap('Default provider is saved independently. Each provider has model and effort defaults; dirty edits survive refresh and accepted requests keep their saved values.', true) },
  render: render(true),
  play: async ({ canvasElement }) => {
    const query = within(canvasElement);
    await choose(canvasElement, '#provider-connection', 'Cursor CLI');
    await query.findByText('agent login', { exact: true });
    if (!query.getByLabelText('API key · optional', { exact: true }) || !query.getByLabelText('Remove saved API key')) throw Error('Cursor key controls missing.');
    const model = query.getByLabelText('Default model', { exact: true }) as HTMLInputElement;
    if (model.value !== 'auto') throw Error('Saved Cursor model default was not loaded.');
    await userEvent.clear(model); await userEvent.type(model, 'team-cursor-model');
    if (!query.getByLabelText('Default provider for new requests')) throw Error('Worker default selector missing.');
    if (!canvasElement.textContent?.includes('Usage remains unknown')) throw Error('Cursor usage guidance missing.');
    await ready(canvasElement);
  },
};
