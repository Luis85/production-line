import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { h, nextTick } from 'vue';
import UApp from '@nuxt/ui/components/App.vue';
import { userEvent, within } from 'storybook/test';
import MetricsProcessesPanel from '../src/worker/webview/components/MetricsProcessesPanel.vue';
import { state } from '../src/worker/webview/store';
import { installWorkerFixture } from './worker-fixtures';
import { processExample } from './worker-process-fixtures';

const meta = { title: 'Worker/Process management', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
type Scenario = 'active' | 'empty' | 'unavailable' | 'offline' | 'uncertain' | 'exhausted' | 'delegated';
let reads = 0, commands: Array<Record<string, unknown>> = [], offline = false, held = false;
let release: (() => void) | undefined;
const storymap = { app: 'Worker', route: '/dashboard', covers: ['src/worker/webview/components/MetricsProcessesPanel.vue'], ready: '[data-processes-ready]', summary: 'Manage explicitly granted development services and inspect worker-launched finite processes with separate resource coverage, bounded lifetime and Feature Request ownership. Fictional snapshots, no OS process started.' };
function render(scenario: Scenario) {
  return () => ({ setup() {
    installWorkerFixture('running'); reads = 0; commands = []; offline = false; held = false; release = undefined;
    const report = processExample(scenario === 'empty', scenario === 'unavailable');
    if (scenario === 'delegated') { report.executions.processes[0].sessionId = 'delegated-child'; state.sessions!.records.find(row => row.id === 'running')!.feature = { key: report.executions.processes[0].featureRequestKey!, id: 'example', source: 'interaction', scope: 'worker-local' }; }
    if (scenario === 'exhausted') Object.assign(report.services.services[0], { restartCount: 2, controls: { stop: true, restart: false, restartUnavailableReason: 'This service has used its granted restart budget.' } });
    const fetcher: typeof fetch = async (input, init = {}) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
      if (path !== '/api/processes') throw Error('Unexpected process story endpoint: ' + path);
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
      if (!init.method || init.method === 'GET') {
        reads++; if (held) await new Promise<void>(resolve => { release = resolve; });
        if (offline) return Response.json({ error: 'Example worker connection lost.' }, { status: 503 });
        report.capturedAt = new Date().toISOString(); return Response.json(report);
      }
      const service = report.services.services[0];
      if (body.action === 'logs') return Response.json({ id: service.id, revision: service.revision, entries: [{ sequence: 9, at: report.capturedAt, stream: 'stdout', text: 'Ready on the configured local port.\n<script>inert output</script>' }], nextAfter: 9, gap: true });
      commands.push(body);
      if (scenario === 'uncertain' && commands.length === 1) return Response.json({ error: 'The response was lost after the service accepted the operation.' }, { status: 503 });
      if (body.action === 'stop') { service.state = 'stopped'; service.endedAt = new Date().toISOString(); service.controls.stop = false; report.services.capacity.active = 0; report.services.summary.activeGroups = 0; }
      return Response.json({ service });
    };
    (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = fetcher;
    return () => h(UApp, null, { default: () => h('main', { style: 'max-width:1200px;margin:auto;padding:24px;min-width:0' }, [h('h1', { style: 'font-size:24px;margin-bottom:12px' }, 'Worker process management'), h('p', { class: 'page-note' }, 'Fictional measurements and operations · no model or process connected'), h(MetricsProcessesPanel)]) });
  } });
}
async function waitFor(check: () => boolean, message: string) { for (let i = 0; i < 150; i++) { await nextTick(); if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error(message); }
async function loaded(canvas: HTMLElement) { await waitFor(() => !!canvas.querySelector('.process-kpis'), 'Process readings failed to load.'); }
async function ready(canvas: HTMLElement) { await nextTick(); canvas.setAttribute('data-processes-ready', 'true'); }
function scenario(name: string, variant: Scenario, check?: (canvas: HTMLElement) => Promise<void>): Story { return { name, parameters: { storymap }, render: render(variant), play: async ({ canvasElement }) => { await loaded(canvasElement); await check?.(canvasElement); await ready(canvasElement); } }; }
export const ActiveServices = scenario('Inspect an owned development service', 'active', async canvas => {
  const ui = within(canvas);
  if (!canvas.querySelector('a[href="/taskboard?session=running"]')) throw Error('Service ownership must link to its Feature Request.');
  await userEvent.click(ui.getByRole('button', { name: 'Inspect logs' }));
  await waitFor(() => !!canvas.querySelector('.service-logs pre'), 'Service logs did not load.');
  if (!canvas.textContent?.includes('Earlier output has expired') || canvas.querySelector('.service-logs script')) throw Error('Log gaps and untrusted output must remain explicit and safe.');
});
export const EmptyWorker = scenario('Explain how services become available', 'empty', async canvas => { if (!canvas.textContent?.includes('Grant a service preset')) throw Error('Empty service history needs an actionable explanation.'); });
export const UnavailableMeasurements = scenario('Keep unavailable measurements distinct from zero', 'unavailable', async canvas => { if (!canvas.querySelector('.process-kpis')?.textContent?.includes('Unavailable') || !canvas.textContent?.includes('0 of 1 active groups')) throw Error('Missing process resources must not become zero usage.'); });
export const StaleControls = scenario('Retain evidence and stop unsafe stale actions', 'offline', async canvas => {
  offline = true; state.refreshRevision++;
  await waitFor(() => !!canvas.textContent?.includes('Last reported values are kept'), 'Read failure must preserve stale process context.');
  if (!(within(canvas).getByRole('button', { name: 'Stop service' }) as HTMLButtonElement).disabled) throw Error('Stale services cannot offer a new management command.');
});
export const UncertainRestart = scenario('Retry an unconfirmed restart exactly once', 'uncertain', async canvas => {
  const ui = within(canvas);
  await userEvent.click(ui.getByRole('button', { name: 'Restart service' }));
  if (commands.length) throw Error('Selecting restart must not immediately mutate a service.');
  await userEvent.click(ui.getByRole('button', { name: 'Confirm restart' }));
  await waitFor(() => !!canvas.textContent?.includes('previous operation is unconfirmed'), 'Uncertain restart needs an exact retry path.');
  await userEvent.click(ui.getByRole('button', { name: 'Retry unconfirmed operation' }));
  await waitFor(() => !!canvas.textContent?.includes('Restart request acknowledged'), 'Exact retry did not complete.');
  if (commands.length !== 2 || JSON.stringify(commands[0]) !== JSON.stringify(commands[1])) throw Error('Uncertain restart retries must preserve the full original command.');
});
export const RestartBudget = scenario('Explain exhausted restart permission', 'exhausted', async canvas => { if (!(within(canvas).getByRole('button', { name: 'Restart service' }) as HTMLButtonElement).disabled || !canvas.textContent?.includes('used its granted restart budget')) throw Error('Restart budget needs an explicit disabled reason.'); });
export const QuietRefresh = scenario('Keep management buttons stable while polling', 'active', async canvas => {
  const button = within(canvas).getByRole('button', { name: 'Stop service' }) as HTMLButtonElement;
  button.focus(); const label = button.textContent, initial = reads; held = true;
  try { state.refreshRevision++; await waitFor(() => reads > initial, 'Quiet process refresh never started.'); if (button.disabled || button.textContent !== label || document.activeElement !== button || button.querySelector('.animate-spin')) throw Error('Background polling must preserve focus and management controls.'); }
  finally { held = false; release?.(); }
});

export const DelegatedProcess = scenario('Open the parent request of a delegated process', 'delegated', async canvas => {
  const processes = canvas.querySelector('.execution-processes');
  if (!processes?.querySelector('a[href="/taskboard?session=running"]') || processes.querySelector('a[href*="delegated-child"]')) throw Error('Delegated process navigation must resolve its canonical Feature Request owner.');
});
