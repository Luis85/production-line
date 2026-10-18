import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { userEvent, within } from 'storybook/test';
import { nextTick } from 'vue';
import { state } from '../src/worker/webview/store';
import { metricsFixture, renderMetricsPage, type MetricsScenario } from './worker-metrics-fixtures';

const meta = { title: 'Worker/Metrics', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
const covers = ['components/WorkerShell', 'pages/MonitoringPage', 'components/MetricsConsumptionPanel', 'components/MetricsResourcesPanel', 'components/MetricsExecutionPanel', 'components/ResourceMonitorPanel'].map(path => 'src/worker/webview/' + path + '.vue');
const storymap = (summary: string) => ({ app: 'Worker', route: '/dashboard', covers, summary, ready: '[data-metrics-ready]' });
async function waitFor(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    await nextTick();
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error(message);
}
async function loaded(canvas: HTMLElement) {
  await waitFor(() => !!canvas.querySelector('[data-resource="cpu"]') && !!canvas.querySelector('#execution-window') && !canvas.textContent?.includes('Loading execution activity'), 'Metrics did not load its resource and execution views.');
  await waitFor(() => metricsFixture().analyses.length > 0 && metricsFixture().resourcesRead > 0, 'Metrics did not request its measurements.');
}
async function ready(canvas: HTMLElement) {
  await nextTick();
  const ids = [...canvas.querySelectorAll('.metrics-page [id]')].map(element => element.id);
  if (new Set(ids).size !== ids.length) throw Error('Metrics contains duplicate element IDs.');
  if (!canvas.querySelector('a[href="/settings#consumption-limits"]')) throw Error('Consumption must link directly to its settings.');
  if (!canvas.querySelector('a[href^="/history"]')) throw Error('Activity must link to retained evidence.');
  if (canvas.querySelectorAll('.metrics-page h1').length !== 1) throw Error('Metrics must retain one page heading.');
  canvas.setAttribute('data-metrics-ready', 'true');
}
function scenario(name: string, description: string, variant: MetricsScenario, check?: (canvas: HTMLElement) => Promise<void>): Story {
  return { name, parameters: { storymap: storymap(description) }, render: renderMetricsPage(variant), play: async ({ canvasElement }) => { await loaded(canvasElement); await check?.(canvasElement); await ready(canvasElement); } };
}
export const ActiveWorker: Story = { name: '01 · Understand this worker at a glance', ...scenario('01 · Understand this worker at a glance', 'Fictional worker identity, queue occupancy, daily token share, current process resources and retained execution activity. Worker and host scope remain explicit.', 'active', async canvas => {
  if (!canvas.textContent?.includes('atlas-workstation')) throw Error('Metrics must retain this worker’s host identity at every viewport.');
  for (const value of ['125,000', '10,000', '365,000']) if (!canvas.textContent?.includes(value)) throw Error('Consumption lost its distinct measured, reserved or remaining amount.');
  if (!canvas.querySelector('meter[aria-label="Worker CPU usage"]')) throw Error('Current CPU must have a labelled meter.');
}) };
export const ExhaustedAllowance: Story = { name: '02 · See why new calls are blocked', ...scenario('02 · See why new calls are blocked', 'An exhausted configured worker share blocks new model calls while accepted work remains queued. The page explains the reset and links to limits without implying that an active call was stopped.', 'exhausted', async canvas => {
  if (!canvas.textContent?.includes('505,130') || !canvas.textContent?.toLowerCase().includes('blocked')) throw Error('Exhaustion must retain actual reported usage and explain blocked starts.');
}) };
export const UnverifiedUsage: Story = { name: '03 · Keep incomplete usage visible', ...scenario('03 · Keep incomplete usage visible', 'A model call without complete usage retains its reservation. The remaining allowance is unverified, rather than a trustworthy balance or zero.', 'uncertain', async canvas => {
  if (!canvas.textContent?.includes('Unverified')) throw Error('Incomplete usage must not show a verified remaining balance.');
}) };
export const NewWorker: Story = { name: '04 · First sample and no retained work', ...scenario('04 · First sample and no retained work', 'A new worker has no retained attempts and has only one CPU sample. CPU and execution measurements remain unavailable while a measured zero-token ledger remains distinct.', 'empty', async canvas => {
  const cpu = canvas.querySelector('[data-resource="cpu"]');
  if (!cpu?.textContent?.includes('Unavailable') || cpu.querySelector('meter')) throw Error('A missing CPU sample must not be drawn as zero.');
  await waitFor(() => !!canvas.textContent?.includes('No retained attempts were accepted in this window.'), 'An empty activity window must explain why there are no attempts.');
}) };
export const StaleWorker: Story = { name: '05 · Inspect cached data while offline', ...scenario('05 · Inspect cached data while offline', 'Independent read failures retain last reported values and mark them stale. The page does not claim a cached worker is idle, healthy or available.', 'stale', async canvas => {
  await waitFor(() => !!canvas.querySelector('[data-execution-metric="duration"]'), 'Initial activity must load before simulating a connection failure.');
  metricsFixture().markOffline();
  await waitFor(() => !!canvas.textContent?.includes('Resource measurements could not be refreshed.') && !!canvas.textContent?.includes('Example worker is offline'), 'Cached measurements need explicit read-failure information.');
  if (!canvas.textContent?.includes('Last reported')) throw Error('Cached resource values must have a last-reported label.');
}) };
export const UnavailableAccounting: Story = { name: '06 · Accounting failure is not zero usage', ...scenario('06 · Accounting failure is not zero usage', 'Unavailable accounting blocks new model calls and suppresses numerical consumption claims. Previously configured allowance is separate from a verified remaining amount.', 'accounting-unavailable', async canvas => {
  const consumption = canvas.querySelector('#consumption-limits');
  if (!consumption?.textContent?.includes('Unavailable') || !consumption.textContent.includes('Unverified')) throw Error('Unavailable accounting must preserve unknown measurement states.');
  if (/(?:^|\s)0 tokens(?:\s|$)/.test(consumption.textContent) || consumption.querySelector('.allocation-bar')) throw Error('Accounting failure must not become a zero-usage gauge.');
}) };
export const LimitsOff: Story = { name: '07 · Track usage without an enforced share', ...scenario('07 · Track usage without an enforced share', 'When limits are off, measured consumption remains visible. No hypothetical remaining allowance is presented as an enforced balance.', 'limits-off', async canvas => {
  const consumption = canvas.querySelector('#consumption-limits');
  if (!consumption?.textContent?.includes('Limits off')) throw Error('Disabled limits must be explicit.');
  if (consumption.querySelector('[data-consumption-metric="remaining"]') || consumption.querySelector('.allocation-bar')) throw Error('Disabled limits must not imply a verified enforced remainder.');
}) };
export const ResourcePressure: Story = { name: '08 · Recognize current resource pressure', ...scenario('08 · Recognize current resource pressure', 'Worker memory crosses its effective-capacity warning and the whole state volume has little free space. Both alerts retain readable labels and context; they do not claim model subprocess usage or automatically stop work.', 'pressure', async canvas => {
  if (canvas.querySelectorAll('.resource-metric.has-warning').length !== 2) throw Error('Memory and disk pressure must both be visible on their metrics.');
  const details = canvas.querySelector<HTMLDetailsElement>('.resource-details');
  if (!details) throw Error('Resource alert details must remain available.');
  await userEvent.click(details.querySelector('summary')!);
  await waitFor(() => details.open && details.querySelectorAll('.resource-alerts li').length === 2, 'Resource details must retain both active alerts.');
  if (!details.textContent?.includes('Worker memory pressure') || !details.textContent.includes('Low state-volume space')) throw Error('Resource alerts must explain their measured scope.');
}) };
export const FilterAndRefresh: Story = { name: '09 · Change the activity window without flicker', ...scenario('09 · Change the activity window without flicker', 'The time filter queries retained attempts by acceptance time. Background refresh preserves selection, keyboard focus, labels and rendered data without loading spinners or duplicate panels.', 'active', async canvas => {
  const select = canvas.querySelector<HTMLSelectElement>('#execution-window');
  if (!select) throw Error('Execution activity needs a labelled time window.');
  const fixture = metricsFixture();
  const previous = fixture.analyses.length;
  await userEvent.selectOptions(select, '24h');
  await waitFor(() => fixture.analyses.length > previous && !!canvas.querySelector('[data-execution-metric="duration"]'), 'Changing the activity window did not load the requested measurements.');
  if (canvas.querySelector('.execution-total strong')?.textContent !== '6') throw Error('The daily window must include only its six example attempts.');
  const query = fixture.analyses.at(-1)!;
  if (!query.since || !query.until || Date.parse(query.until) - Date.parse(query.since) !== 86_400_000) throw Error('Last 24 hours must query one complete day by acceptance time.');
  select.focus();
  const refresh = within(canvas).getByRole('button', { name: 'Refresh activity' }) as HTMLButtonElement;
  const text = refresh.textContent, duration = canvas.querySelector('[data-execution-metric="duration"]')?.textContent;
  const requests = fixture.analyses.length;
  fixture.holdReads();
  try {
    state.refreshRevision++;
    await waitFor(() => fixture.analyses.length > requests, 'Background refresh did not request activity.');
    if (document.activeElement !== select || select.value !== '24h') throw Error('Background refresh moved focus or changed the selected window.');
    if (refresh.textContent !== text || refresh.querySelector('.animate-spin') || refresh.disabled) throw Error('Background refresh must keep the action label and enabled state stable.');
    if (canvas.querySelector('[data-execution-metric="duration"]')?.textContent !== duration) throw Error('Background refresh removed visible measurements.');
  } finally { fixture.releaseReads(); }
  await nextTick();
  const count = fixture.analyses.length;
  await userEvent.selectOptions(select, 'all');
  await waitFor(() => fixture.analyses.length > count && !fixture.analyses.at(-1)?.since && canvas.querySelector('.execution-total strong')?.textContent === '12', 'All retained attempts must remove the lower date boundary and include all twelve examples.');
}) };
