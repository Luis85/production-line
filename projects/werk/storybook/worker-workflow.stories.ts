import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { nextTick } from 'vue';
import { userEvent, within, waitFor } from 'storybook/test';
import { renderWorkflow, type installWorkflowFixture } from './worker-workflow-fixtures';
const meta = { title: 'Worker/Workflow', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
let fixture: ReturnType<typeof installWorkflowFixture>;
const covers = ['pages/WorkflowPage', 'components/WorkflowFlowPanel', 'components/WorkflowVelocity', 'components/WorkflowEvidencePanel', 'components/WorkerShell'].map(path => 'src/worker/webview/' + path + '.vue');
const storymap = (summary: string) => ({ app: 'Worker', summary, covers, route: '/workflow', ready: '[data-workflow-ready]' });
const render = (scenario: Parameters<typeof renderWorkflow>[0]) => renderWorkflow(scenario, value => { fixture = value; });
async function ready(canvas: HTMLElement) { await nextTick(); if (document.documentElement.scrollWidth > innerWidth + 1) throw Error('Workflow page overflowed.'); canvas.setAttribute('data-workflow-ready', 'true'); }
export const ObservedDelivery: Story = {
  name: 'Inspect flow, confirmed delivery and honest EBM evidence', parameters: { storymap: storymap('Current stage pressure remains separate from completion-window velocity. Customer and business outcomes remain unmeasured, with measured operational samples disclosed.') }, render: render('populated'),
  play: async ({ canvasElement }) => { const q = within(canvasElement); await q.findByRole('heading', { name: 'Weekly delivery velocity' });
    if (canvasElement.querySelectorAll('[data-workflow-column]').length !== 8) throw Error('Full workflow stages are missing.');
    for (const area of ['current_value', 'unrealized_value', 'time_to_market', 'ability_to_innovate']) if (!canvasElement.querySelector('[data-ebm-area=' + area + ']')) throw Error('Missing EBM area ' + area);
    await userEvent.click(q.getByText('Weekly values and exact UTC bounds')); await q.findByRole('table', { name: 'Confirmed completed increments · UTC weeks' }); await ready(canvasElement);
  }
};
export const FilterWorkflow: Story = {
  name: 'Change project and completion window without losing other projects', parameters: { storymap: storymap('Project selection applies to observed flow and outcomes. The time selector scopes completion evidence; changing it clears earlier matching values and sends explicit UTC bounds.') }, render: render('populated'),
  play: async ({ canvasElement }) => { const q = within(canvasElement), project = await q.findByLabelText('Project') as HTMLSelectElement; await waitFor(() => { if (project.options.length < 3) throw Error('Project choices not loaded.'); });
    await userEvent.selectOptions(project, 'portal'); await waitFor(() => { if (fixture.queries.at(-1)?.projectId !== 'portal') throw Error('Project scope not sent.'); });
    await userEvent.selectOptions(q.getByLabelText('Completed within'), '7d'); await waitFor(() => { const value = fixture.queries.at(-1); if (!value?.since || !value.until || Date.parse(value.until) - Date.parse(value.since) !== 7 * 86_400_000) throw Error('Completion filter lost its exact time bounds.'); });
    if (![...project.options].some(option => option.value === 'atlas')) throw Error('Filtered response removed the other project choice.'); await q.findByRole('heading', { name: 'Weekly delivery velocity' }); await ready(canvasElement);
  }
};
export const MissingEvidence: Story = {
  name: 'Keep unavailable histories and unsupported value outcomes explicit', parameters: { storymap: storymap('Unknown historical state is separate from zero WIP. Missing lead/cycle starts and unsupported customer value are unmeasured rather than zero.') }, render: render('unmeasured'),
  play: async ({ canvasElement }) => { const q = within(canvasElement); await q.findByText('2 historical request states could not be reconstructed at this observation time.');
    for (const id of ['lead', 'cycle', 'rework', 'failures']) if (!canvasElement.querySelector('[data-workflow-metric=' + id + ']')?.textContent?.includes('Unmeasured')) throw Error('Missing observations were shown as zero: ' + id);
    await userEvent.click(q.getByText('Customer value and evidence-based management',{exact:true})); await q.findByText('Customer outcomes, satisfaction, revenue and realized business value are not recorded.'); await ready(canvasElement);
  }
};
export const FailedRefresh: Story = {
  name: 'Retain only matching evidence after a failed refresh', parameters: { storymap: storymap('A failed read retains the matching last snapshot with its error. A different project clears that evidence until a successful read; retry keeps the chosen project.') }, render: render('populated'),
  play: async ({ canvasElement }) => { const q = within(canvasElement); await q.findByRole('heading', { name: 'Weekly delivery velocity' }); fixture.setUnavailable(true); await userEvent.click(q.getByRole('button', { name: 'Refresh workflow' })); await q.findByRole('alert');
    if (!q.getByRole('heading', { name: 'Observed workflow' })) throw Error('Matching last evidence disappeared after a failed refresh.');
    await userEvent.selectOptions(q.getByLabelText('Project'), 'portal'); await waitFor(() => { if (q.queryByRole('heading', { name: 'Observed workflow' })) throw Error('Previous project evidence leaked under a new project.'); });
    fixture.setUnavailable(false); await userEvent.click(q.getByRole('button', { name: 'Refresh workflow' })); await q.findByRole('heading', { name: 'Observed workflow' }); if ((q.getByLabelText('Project') as HTMLSelectElement).value !== 'portal') throw Error('Retry discarded the project scope.'); fixture.setUnavailable(true); await userEvent.click(q.getByRole('button', { name: 'Refresh workflow' })); await q.findByRole('alert'); await q.findByText(/Last successful snapshot/); await ready(canvasElement);
  }
};
export const EmptyWorkflow: Story = { name: 'Start collecting workflow evidence', parameters: { storymap: storymap('An empty worker explains how evidence becomes available and keeps unavailable timing distinct from zero recorded deliveries.') }, render: render('empty'), play: async ({ canvasElement }) => { const q = within(canvasElement); await q.findByText(/No retained Feature Requests match this project/); await q.findByRole('link', { name: 'create a Feature Request' }); await ready(canvasElement); } };
export const PausedObservations: Story = { name: 'Identify paused browser observations', parameters: { storymap: storymap('Pausing browser reads leaves the observation time and retained workflow facts visible without pausing worker execution.') }, render: render('paused'), play: async ({ canvasElement }) => { await within(canvasElement).findByText(/browser updates paused/); await ready(canvasElement); } };
export const LoadingWorkflow: Story = { name: 'Wait for the first private workflow snapshot', parameters: { storymap: { ...storymap('Loading does not present placeholder counts or fabricated flow evidence.'), covers: ['src/worker/webview/pages/WorkflowPage.vue', 'src/worker/webview/components/WorkerShell.vue'] } }, render: render('loading'), play: async ({ canvasElement }) => { await within(canvasElement).findByRole('status', { name: 'Loading workflow evidence' }); if (canvasElement.querySelector('[data-workflow-column]')) throw Error('Loading fabricated workflow state.'); await ready(canvasElement); } };
