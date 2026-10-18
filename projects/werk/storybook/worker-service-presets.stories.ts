import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { h, nextTick } from 'vue';
import UApp from '@nuxt/ui/components/App.vue';
import ToolAccessPanel from '../src/worker/webview/components/ToolAccessPanel.vue';
import { state } from '../src/worker/webview/store';
import { installWorkerFixture } from './worker-fixtures';
const meta = { title: 'Worker/Service presets', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
function render(configured = false, blocked = false) {
  return () => ({ setup() {
    installWorkerFixture('empty'); state.settings!.board.paused = !blocked;
    state.toolAccess = { schemaVersion: 1, revision: 1, builtins: { files: false, commands: [], cliTools: [], webOrigins: [] }, mcp: [], canEdit: !blocked,
      saveBlockedReason: blocked ? 'Pause new starts and drain queued and running work before saving.' : null, workerNode: '/example/bin/node',
      ...(configured ? { services: { enabled: true, maxActive: 4, presets: [{ id: 'preview', name: 'Project preview server', executable: '/example/bin/node', args: ['scripts/dev-server.mjs', '--host', '127.0.0.1'], enabled: true,
        ttlMs: 3600000, startupTimeoutMs: 30000, readyText: 'Server listening', restart: { maxAttempts: 2, backoffMs: 1000 } }] } } : {}) };
    return () => h(UApp, null, { default: () => h('div', { style: 'max-width:1050px;margin:auto;padding:24px;min-width:0' }, [h('p', { class: 'page-note' }, 'Illustrative settings · no service is started'), h(ToolAccessPanel)]) });
  } });
}
const storymap = (summary: string) => ({ app: 'Worker', summary, covers: ['src/worker/webview/components/ToolAccessPanel.vue', 'src/worker/webview/components/ServicePresetsEditor.vue'], route: '/settings#tool-access', ready: '[data-service-presets-ready]' });
async function element<T extends HTMLElement>(canvas: HTMLElement, selector: string): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = canvas.querySelector<T>(selector); if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('Service settings did not render ' + selector);
}
const ready = async (canvas: HTMLElement) => { await nextTick(); canvas.setAttribute('data-service-presets-ready', 'true'); };
export const DefaultOff: Story = {
  name: 'Development services are disabled by default',
  parameters: { storymap: storymap('Older grants show service access disabled with no fabricated edit. Services require an explicit grant and a fixed enabled preset.') },
  render: render(),
  play: async ({ canvasElement }) => {
    const enabled = await element<HTMLInputElement>(canvasElement, '#tool-services-enabled');
    if (enabled.checked || !canvasElement.querySelector<HTMLButtonElement>('.tool-save-actions button[type="submit"]')?.disabled) throw Error('Loading omitted service settings must leave access off and unchanged.');
    await ready(canvasElement);
  },
};
export const SavedPreset: Story = {
  name: 'Configure a bounded project preview service',
  parameters: { storymap: storymap('A fixed executable and arguments run only in the Feature Request worktree. Lifetime, restart limits and literal readiness reporting remain explicit; liveness is not application health.') },
  render: render(true),
  play: async ({ canvasElement }) => {
    const lifetime = await element<HTMLInputElement>(canvasElement, '#service-lifetime-0');
    if (lifetime.value !== '60' || !(await element<HTMLInputElement>(canvasElement, '#tool-services-enabled')).checked) throw Error('Saved service limits and grant must be displayed.');
    (await element<HTMLDetailsElement>(canvasElement, '.service-options')).open = true;
    if (!(await element(canvasElement, '#service-ready-help-0')).textContent?.includes('does not verify application health')) throw Error('Reported readiness must not be called verified health.');
    await ready(canvasElement);
  },
};
export const InvalidLifetime: Story = {
  name: 'Correct an excessive service lifetime',
  parameters: { storymap: storymap('A service lifetime beyond 24 hours remains a visible draft and blocks saving instead of silently extending or truncating the permission.') },
  render: render(true),
  play: async ({ canvasElement }) => {
    const lifetime = await element<HTMLInputElement>(canvasElement, '#service-lifetime-0'); lifetime.value = '1441'; lifetime.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick(); const error = await element(canvasElement, '#tool-services-validation');
    if (!error.textContent?.includes('24 hours') || !canvasElement.querySelector('.service-editor')?.getAttribute('aria-describedby')?.includes(error.id) || !canvasElement.querySelector<HTMLButtonElement>('.tool-save-actions button[type="submit"]')?.disabled || lifetime.value !== '1441') throw Error('Invalid lifetime must stay visible and prevent saving.');
    await ready(canvasElement);
  },
};
export const DraftWhileRunning: Story = {
  name: 'Keep service edits while waiting to save access',
  parameters: { storymap: storymap('Service changes remain drafts until existing pause-and-drain controls permit saving. Polling does not overwrite input, move focus or show action spinners.') },
  render: render(true, true),
  play: async ({ canvasElement }) => {
    const name = await element<HTMLInputElement>(canvasElement, '#service-name-0'); name.value = 'Unsaved preview name'; name.dispatchEvent(new Event('input', { bubbles: true })); name.focus();
    const save = await element<HTMLButtonElement>(canvasElement, '.tool-save-actions button[type="submit"]'); const label = save.textContent;
    state.toolAccess = { ...state.toolAccess! }; await nextTick();
    if (name.value !== 'Unsaved preview name' || document.activeElement !== name || !save.disabled || save.textContent !== label || state.toolAccess.services?.presets[0]?.name === name.value) throw Error('Polling must preserve the draft and focus without saving it.');
    await ready(canvasElement);
  },
};
