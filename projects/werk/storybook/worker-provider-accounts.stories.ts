import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { h, nextTick } from 'vue';
import UApp from '@nuxt/ui/components/App.vue';
import ProviderAccountPanel from '../src/worker/webview/components/ProviderAccountPanel.vue';
import type { ProviderAccountStatus } from '../src/worker/application/provider-account';
import { installWorkerFixture, fixtureTime } from './worker-fixtures';
const meta = { title: 'Worker/Provider accounts', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
const base: ProviderAccountStatus = { id: 'claude-cli', signedIn: 'unknown', account: null, email: null, organization: null, subscription: null, authMethod: null, checkedAt: fixtureTime, message: 'This CLI did not expose a supported account status. Update it or inspect its status in the worker account terminal.' };
function render(value: ProviderAccountStatus, failure = false) { return () => ({ setup() {
  const fixture = installWorkerFixture('empty');
  const fetchFixture: typeof fetch = (input, init) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
    if (path === '/api/providers/account') return Promise.resolve(failure ? Response.json({ error: 'Account check is temporarily unavailable.' }, { status: 503 }) : Response.json(value));
    return fixture.fetchFixture(input, init);
  };
  (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = fetchFixture;
  return () => h(UApp, null, { default: () => h('div', { style: 'max-width:750px;margin:auto;padding:24px;min-width:0' }, [h('p', { class: 'page-note' }, 'Illustrative account details · no real CLI or provider is contacted'), h(ProviderAccountPanel, { providerId: value.id, connectionKey: '/example/provider-cli', enabled: true })]) });
} }); }
const storymap = (summary: string) => ({ app: 'Worker', summary, covers: ['src/worker/webview/components/ProviderAccountPanel.vue'], route: '/dashboard#provider-connections', ready: '[data-provider-account-ready]' });
async function settled(canvas: HTMLElement, text: string) { for (let n = 0; n < 100; n++) { if (canvas.textContent?.includes(text)) { await nextTick(); canvas.setAttribute('data-provider-account-ready', 'true'); return; } await new Promise(resolve => setTimeout(resolve, 20)); } throw Error('Account fixture did not render ' + text); }
export const ClaudeSubscription: Story = { name: 'Claude subscription account reported by CLI', parameters: { storymap: storymap('The worker displays only the email, organization, subscription and authentication method reported by the configured CLI.') }, render: render({ ...base, signedIn: true, email: 'operator@example.com', organization: 'Example product team', subscription: 'max', authMethod: 'claude.ai', message: 'Claude Code reported these account details. Subscription quota and model access were not checked.' }), play: async ({ canvasElement }) => { await settled(canvasElement, 'operator@example.com'); if (!canvasElement.querySelector('dd')?.textContent?.includes('operator@example.com')) throw Error('Reported email missing.'); } };
export const CodexIdentityUnavailable: Story = { name: 'Codex login without account identity', parameters: { storymap: storymap('A reported Codex login shows its authentication method while unavailable identity and subscription details remain explicit.') }, render: render({ ...base, id: 'codex-cli', signedIn: true, authMethod: 'ChatGPT', message: 'Codex reports a signed-in account. Account identity and subscription details are unavailable from this CLI status command.' }), play: async ({ canvasElement }) => { await settled(canvasElement, 'Subscription details are unavailable'); if (canvasElement.textContent?.includes('operator@example.com')) throw Error('Account identity must not carry across providers.'); } };
export const SignedOut: Story = { name: 'CLI reports signed out', parameters: { storymap: storymap('Signed-out accounts retain a clear read-only refresh action and never show stale identity details.') }, render: render({ ...base, signedIn: false, message: 'Claude Code reports no signed-in account for the worker process owner.' }), play: async ({ canvasElement }) => { await settled(canvasElement, 'Signed out'); if (canvasElement.querySelector('dd')) throw Error('Signed-out view must not show account identity.'); } };
export const Unavailable: Story = { name: 'Account status unavailable', parameters: { storymap: storymap('A failed account request explains how to retry without making a sign-in or subscription claim.') }, render: render(base, true), play: async ({ canvasElement }) => { await settled(canvasElement, 'Account check is temporarily unavailable.'); if (!canvasElement.querySelector('[role="alert"]')) throw Error('Account failure must be announced.'); } };
