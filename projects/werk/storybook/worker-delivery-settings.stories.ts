import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { h, nextTick } from 'vue';
import UApp from '@nuxt/ui/components/App.vue';
import { userEvent, within, waitFor } from 'storybook/test';
import DeliveryPolicyPanel from '../src/worker/webview/components/DeliveryPolicyPanel.vue';
import SettingsPanel from '../src/worker/webview/components/SettingsPanel.vue';
import { state } from '../src/worker/webview/store';
import { installWorkerFixture } from './worker-fixtures';
import { providerCapabilities } from '../src/worker/application/provider-capabilities';
const meta = { title: 'Worker/Delivery setup', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
const profiles = [{ id: 'feature', minimumCriteria: 2, minimumMessageLength: 20, maxRepairAttempts: 2, verificationInputs: ['tests/', 'package.json', '.werk/delivery-policy.json'] }, { id: 'lightweight', minimumCriteria: 0, minimumMessageLength: 1, maxRepairAttempts: 1, verificationInputs: ['tests/', 'package.json', '.werk/delivery-policy.json'] }];
function render(policy: boolean, legacy = false) { return () => ({ setup() {
  const fixture = installWorkerFixture('settings-ready');
  state.settings!.providers[0].authenticationMode = legacy ? 'legacy' : 'cli-account';
  state.settings!.providers[0].capabilities = providerCapabilities('codex-cli');
  const fetchFixture: typeof fetch = (input, init) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (path === '/api/requests' && body.action === 'delivery_policy') return Promise.resolve(Response.json({ repositoryId: null, approvalRequired: false, approved: true, approvedAt: null, approvalRevision: 0, machineMaxParallel: 1, schemaVersion: 1, baseline: 'a'.repeat(40), configurationDigest: 'example-committed-policy', configuration: { schemaVersion: 1, version: 1, defaultProfile: 'feature', reviewDirectory: 'feature-reviews', profiles }, profile: profiles[0] }));
    return fixture.fetchFixture(input, init);
  };
  (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = fetchFixture;
  return () => h(UApp, null, { default: () => h('main', { style: 'padding:24px;max-width:850px;margin:auto;min-width:0' }, [h('p', { class: 'page-note' }, 'Illustrative setup · no credentials, configuration or Git state changed'), policy ? h(DeliveryPolicyPanel) : h(SettingsPanel, { providerOnly: true })]) });
} }); }
const storymap = (summary: string, policy = false) => ({ app: 'Worker', summary, covers: policy ? ['src/worker/webview/components/DeliveryPolicyPanel.vue'] : ['src/worker/webview/components/SettingsPanel.vue', 'src/worker/webview/components/ProviderCapabilitiesPanel.vue'], route: '/settings#' + (policy ? 'delivery-policy' : 'provider-connections'), ready: '[data-delivery-setup-ready]' });
async function ready(canvas: HTMLElement) { await nextTick(); if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) throw Error('Delivery setup overflows.'); canvas.setAttribute('data-delivery-setup-ready', 'true'); }
export const CommittedPolicy: Story = {
  name: 'Preview committed project policy before starting work',
  parameters: { storymap: storymap('Named quality profiles expose their readiness requirements, repair limits and protected verification inputs. Preview does not change an accepted request or publish local edits.', true) }, render: render(true),
  play: async ({ canvasElement }) => { const query = within(canvasElement); await query.findByText('Default quality profile'); await userEvent.selectOptions(query.getByLabelText('Preview a quality profile'), 'lightweight'); if (!canvasElement.textContent?.includes('Previewing a profile here does not change')) throw Error('Preview authority is unclear.'); await ready(canvasElement); },
};
export const ExplicitAuthentication: Story = {
  name: 'Choose account or API billing for a legacy connection',
  parameters: { storymap: storymap('A saved legacy connection requires an explicit authentication choice. The provider’s limits remain visible and choosing subscription authentication does not enable an API fallback.') }, render: render(false, true),
  play: async ({ canvasElement }) => {
    const query = within(canvasElement); await query.findByText('Choose an authentication method before starting new work.', { exact: false });
    if (!(query.getByRole('button', { name: 'Save provider' }) as HTMLButtonElement).disabled) throw Error('Legacy authentication must require a choice.');
    await userEvent.click(query.getByLabelText('Authentication and billing')); await userEvent.click(await within(document.body).findByRole('option', { name: 'Provider account / subscription' }));
    await waitFor(() => { if (getComputedStyle(document.body).pointerEvents === 'none') throw Error('Authentication menu is closing.'); });
    if (query.queryByLabelText('API key', { exact: true })) throw Error('Account mode silently exposed an API-key fallback.');
    await userEvent.click(query.getByText('Connection capabilities and limits')); await ready(canvasElement);
  },
};
