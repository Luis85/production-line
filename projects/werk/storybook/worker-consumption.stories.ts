import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { h, nextTick } from 'vue';
import UApp from '@nuxt/ui/components/App.vue';
import ConsumptionPanel from '../src/worker/webview/components/ConsumptionPanel.vue';
import type { ConsumptionStatus } from '../src/worker/application/consumption';
import { state } from '../src/worker/webview/store';
import { installWorkerFixture } from './worker-fixtures';
const meta = { title: 'Worker/Consumption limits', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
type Scenario = 'off' | 'available' | 'exhausted' | 'unknown' | 'unavailable';
function render(scenario: Scenario) { return () => ({ setup() {
  const fixture = installWorkerFixture('empty');
  const policy = { enabled: scenario !== 'off', period: 'daily' as const, allowance: 1_000_000, workerPercent: 50, perRunReservation: 10_000 };
  const report: ConsumptionStatus = { schemaVersion: 1, policy, periodStart: '2026-10-16T00:00:00.000Z', periodEnd: '2026-10-17T00:00:00.000Z', workerAllowance: 500_000, measuredTokens: 125_000, reservedTokens: 10_000, chargedTokens: 135_000, remainingTokens: 365_000, activeInvocations: 1, uncertainInvocations: 0, blocked: false, reason: scenario === 'off' ? 'disabled' : 'available', accountingAvailable: true, trackingStartedAt: '2026-10-16T08:00:00.000Z' };
  if (scenario === 'exhausted') Object.assign(report, { measuredTokens: 505_130, reservedTokens: 0, chargedTokens: 505_130, remainingTokens: 0, activeInvocations: 0, blocked: true, reason: 'exhausted' });
  if (scenario === 'unknown') Object.assign(report, { activeInvocations: 0, uncertainInvocations: 1, blocked: true, reason: 'unmeasured_usage' });
  if (scenario === 'unavailable') Object.assign(report, { accountingAvailable: false, measuredTokens: 0, reservedTokens: 0, chargedTokens: 0, remainingTokens: 500_000, activeInvocations: 0, blocked: true, reason: 'accounting_unavailable', trackingStartedAt: null });
  state.settings!.consumption = policy; state.consumption = report;
  const fetchFixture: typeof fetch = (input, init) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
    if (path === '/api/consumption') return Promise.resolve(Response.json(report));
    return fixture.fetchFixture(input, init);
  };
  (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = fetchFixture;
  return () => h(UApp, null, { default: () => h('div', { style: 'max-width:1050px;margin:auto;padding:24px;min-width:0' }, [h('p', { class: 'page-note' }, 'Illustrative consumption · no provider or account is contacted'), h(ConsumptionPanel)]) });
} }); }
const storymap = (summary: string) => ({ app: 'Worker', summary, covers: ['src/worker/webview/components/ConsumptionPanel.vue'], route: '/dashboard#consumption-limits', ready: '[data-consumption-ready]' });
async function ready(canvas: HTMLElement) { await nextTick(); canvas.setAttribute('data-consumption-ready', 'true'); }
export const ConfigureShare: Story = { name: 'Configure a daily 50/50 share', parameters: { storymap: storymap('Limits begin disabled. Configure a daily or monthly allowance, a worker share and reservation without resetting recorded usage.') }, render: render('off'), play: async ({ canvasElement }) => { await nextTick(); canvasElement.querySelector<HTMLDetailsElement>('.consumption-editor')!.open = true; if (!canvasElement.querySelector('label[for="consumption-share"]')) throw Error('Worker share must have an accessible label.'); await ready(canvasElement); } };
export const ActiveCall: Story = { name: 'Reported usage and active reservation', parameters: { storymap: storymap('Measured tokens, reserved tokens, remaining allowance and UTC reset stay distinct. Active model calls may overrun a reservation.') }, render: render('available'), play: async ({ canvasElement }) => ready(canvasElement) };
export const AllowanceExhausted: Story = { name: 'Worker share used', parameters: { storymap: storymap('The blocked state explains the next UTC reset and allowance adjustment without claiming that an active call was forcibly stopped.') }, render: render('exhausted'), play: async ({ canvasElement }) => { await nextTick(); if (!canvasElement.textContent?.includes('New model calls blocked')) throw Error('Exhaustion must remain explicit.'); await ready(canvasElement); } };
export const MissingUsage: Story = { name: 'Incomplete usage blocks new calls', parameters: { storymap: storymap('Missing provider usage keeps reservations and prevents a misleading measured remainder. The operator can inspect run evidence and the next reset.') }, render: render('unknown'), play: async ({ canvasElement }) => { await nextTick(); if (!canvasElement.textContent?.includes('Unverified')) throw Error('Unknown usage must not show a verified remainder.'); await ready(canvasElement); } };
export const AccountingUnavailable: Story = { name: 'Accounting storage unavailable', parameters: { storymap: storymap('Unavailable accounting blocks new calls and displays unavailable values instead of zero usage, with storage and restart guidance.') }, render: render('unavailable'), play: async ({ canvasElement }) => { await nextTick(); if (canvasElement.querySelector('dd')?.textContent !== 'Unavailable') throw Error('Failed accounting must not display zero usage.'); await ready(canvasElement); } };
