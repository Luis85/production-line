import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { h, nextTick } from 'vue';
import UApp from '@nuxt/ui/components/App.vue';
import ExecutionProfilesPanel from '../src/worker/webview/components/ExecutionProfilesPanel.vue';
import { state } from '../src/worker/webview/store';
import { installWorkerFixture } from './worker-fixtures';
const meta = { title: 'Worker/Execution profiles', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
function render(pending = false) {
  return () => ({ setup() {
    const fixture = installWorkerFixture('empty');
    const profiles = [{ id: 'release-review', provider: 'codex' as const, mode: 'mock' as const, maxParallel: 1 as const }, { id: 'documentation', provider: 'claude' as const, mode: 'mock' as const, maxParallel: 1 as const }];
    state.settings!.board.paused = true;
    state.executionProfiles = { schemaVersion: 1, profiles, configurationHash: 'storybook-profiles', mode: 'mock', allowedProviders: ['claude', 'codex'], maxProfiles: 8, state: pending ? 'pending' : 'ready', pending: pending ? { configurationHash: 'storybook-requested', profiles: [{ ...profiles[0], id: 'release-review-updated' }, profiles[1]] } : null, canEdit: !pending, saveBlockedReason: pending ? 'Waiting for orchestrator acceptance.' : null };
    const fetchFixture: typeof fetch = (input, init) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href).pathname;
      if (path === '/api/execution-profiles') return Promise.resolve(init?.method === 'POST' ? Response.json({ error: 'Illustrative fixture. Runtime changes are disabled.' }, { status: 409 }) : Response.json(state.executionProfiles));
      return fixture.fetchFixture(input, init);
    };
    (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = fetchFixture;
    return () => h(UApp, null, { default: () => h('div', { style: 'max-width:1050px;margin:auto;padding:24px;min-width:0' }, [h('p', { class: 'page-note' }, 'Illustrative example · no provider connected'), h(ExecutionProfilesPanel)]) });
  } });
}
const storymap = (summary: string) => ({ app: 'Worker', summary, covers: ['src/worker/webview/components/ExecutionProfilesPanel.vue'], route: '/dashboard#execution-profiles', ready: '[data-worker-profiles-ready]' });
const ready = async ({ canvasElement }: { canvasElement: HTMLElement }) => { await nextTick(); canvasElement.setAttribute('data-worker-profiles-ready', 'true'); };
export const EditProfiles: Story = { name: 'Edit named provider profiles', parameters: { storymap: storymap('Operators edit named assignment profiles, with supported providers, one shared slot, and explicit save controls.') }, render: render(), play: ready };
export const WaitingForOrchestrator: Story = { name: 'Saved update awaiting acceptance', parameters: { storymap: storymap('A persisted update shows requested profiles separately from the active profiles until the orchestrator accepts it.') }, render: render(true), play: ready };
