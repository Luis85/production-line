import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { userEvent, within } from 'storybook/test';
import { h, nextTick } from 'vue';
import TaskIntake from '../src/worker/webview/components/TaskIntake.vue';
import { state } from '../src/worker/webview/store';
import { readFeatureDetails, writeFeatureDetail } from '../src/worker/webview/feature-authoring-fields';
import type { FeatureAuthoringCommand, FeatureAuthoringResult } from '../src/worker/application/feature-authoring-contracts';
import { installWorkerFixture } from './worker-fixtures';

const meta = { title: 'Worker/Shared feature requests', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
const binding = { repositoryId: 'orders-project', remote: 'origin', branch: 'team-intake', workflowPath: '.werk/feature-workflow.json' };
const initialMarkdown = ['---', 'schemaVersion: 1', 'id: fr-csv-export', 'templateId: orders-v1', 'title: Add CSV export', 'status: draft', 'mode: patch', 'provider: codex-cli', 'paths: []', '---', '# Goal', '', 'Add CSV export to orders.', '', '## Context', '', '<!-- Describe the problem. -->', '', '## Acceptance criteria', '', '<!-- Add observable results. -->', '', '## Verification plan', '', '<!-- Explain verification. -->', '', '## Team review', '', 'Finance reviews the export.'].join('\n');

/** Fictional API replies demonstrate presentation only; no Git publication or model call occurs. */
function installAuthoringFixture(reviewRequired = false) {
  const base = installWorkerFixture('empty');
  state.environment!.sharedIntake = { dependencyPlans: [], selectedProjectId: 'demo', projects: [{id:'demo',label:'Demo project',enabled:true}], revision: 1, workerId: 'example-worker', config: { ...binding, enabled: true, pollMs: 15_000 }, canEdit: true, blockedReason: null, state: 'idle', error: null, lastSyncedAt: null, sourceCommit: null, workflow: null, requests: [] };
  const fetchFixture: typeof fetch = async (input, init) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
    if (path === '/api/shared-intake') return Response.json(state.environment!.sharedIntake);
    if (path !== '/api/features' || init?.method !== 'POST') return base.fetchFixture(input, init);
    const command: FeatureAuthoringCommand = JSON.parse(String(init.body));
    if (command.action !== 'prepare') throw Error('This example only prepares a draft.');
    let markdown = command.markdown ?? initialMarkdown;
    if (command.seed) for (const field of ['provider', 'model', 'effort'] as const) if (command.seed[field]) markdown = writeFeatureDetail(markdown, field, command.seed[field]!);
    const details = readFeatureDetails(markdown);
    const valid = reviewRequired || Object.values(details.fields).every(value => value.trim()) && !!details.paths.trim();
    const result: FeatureAuthoringResult = { featureId: 'fr-csv-export', name: 'fr-csv-export.md', path: 'features/fr-csv-export.md', markdown, revision: null, status: 'draft', readiness: { ...(reviewRequired ? { reviewRequired: true } : {}), valid, errors: valid ? [] : [{ code: 'missing_details', message: 'Complete context, acceptance criteria, verification plan and approved paths.' }] }, workflowDigest: 'illustrative-workflow', binding };
    return Response.json(result);
  };
  (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = fetchFixture;
}
function renderFixture(reviewRequired = false) {
  return { setup() {
    installAuthoringFixture(reviewRequired);
    return () => h('main', { style: 'max-width:760px;margin:auto;padding:24px;min-width:0' }, [
      h('p', { class: 'page-note' }, 'Illustrative example · no Git publication, readiness verification or model execution'), h(TaskIntake),
    ]);
  } };
}
const render = () => renderFixture();
function storymap(summary: string, details = false) {
  return { app: 'Worker', summary, covers: ['TaskIntake', 'SharedFeatureComposer', ...(details ? ['FeatureRequestDetails'] : [])].map(name => 'src/worker/webview/components/' + name + '.vue'), route: '/taskboard', ready: '[data-authoring-ready]' };
}
async function ready(canvas: HTMLElement) { await nextTick(); canvas.setAttribute('data-authoring-ready', 'true'); }
export const DescribeRequest: Story = {
  name: 'Describe a request in chat for the shared Markdown queue',
  parameters: { storymap: storymap('The chat entry point prepares the same project Feature Request used by the Git intake. Drafting does not dispatch a model or create a separate task.') },
  render,
  play: async ({ canvasElement }) => {
    await userEvent.type(within(canvasElement).getByLabelText('Request instructions', { exact: true }), 'Add CSV export to orders so finance can reconcile the month.');
    await ready(canvasElement);
  },
};
export const CompleteRequestDetails: Story = {
  name: 'Complete plain request details before explicitly publishing ready',
  parameters: { storymap: storymap('Template fields retain one Feature Request ID. The worker checks readiness before the user can explicitly publish ready; custom Markdown remains available under advanced editing.', true) },
  render,
  play: async ({ canvasElement }) => {
    const query = within(canvasElement);
    await userEvent.type(query.getByLabelText('Request instructions', { exact: true }), 'Add CSV export to orders.');
    await userEvent.click(query.getByRole('button', { name: 'Prepare request' }));
    const context = await query.findByLabelText('Context', { exact: true });
    if ((context as HTMLTextAreaElement).value) throw Error('Template guidance must not appear as a completed answer.');
    const publish = query.getByRole('button', { name: 'Mark ready and publish' }) as HTMLButtonElement;
    if (!publish.disabled) throw Error('Incomplete requests cannot publish ready.');
    await userEvent.type(context, 'Finance reconciles orders at the end of each month.');
    await userEvent.type(query.getByLabelText('Acceptance criteria', { exact: true }), 'Export includes every selected order with its total.');
    await userEvent.type(query.getByLabelText('Verification plan', { exact: true }), 'Run the export tests and inspect the CSV headers.');
    await userEvent.type(query.getByLabelText('Approved repository paths', { exact: true }), 'src/orders/export.ts\ntests/orders/export.test.ts');
    await userEvent.click(query.getByRole('button', { name: 'Check readiness' }));
    await query.findByRole('heading', { name: 'Ready checks passed' });
    if (publish.disabled) throw Error('A checked request should offer an explicit ready publication.');
    if (canvasElement.querySelector<HTMLDetailsElement>('.advanced-template')?.open) throw Error('Raw Markdown must remain an advanced option.');
    await ready(canvasElement);
  },
};

export const SubmitForReadyCheck: Story = {
  name: 'Prepare an incomplete request for the opt-in Ready Check',
  parameters: { storymap: storymap('Structural eligibility for the opt-in model review is labelled separately from passed Definition of Ready checks. A ready publication remains explicit.', true) },
  render: () => renderFixture(true),
  play: async ({ canvasElement }) => {
    const query = within(canvasElement);
    await userEvent.type(query.getByLabelText('Request instructions', { exact: true }), 'Add CSV export to orders.');
    await userEvent.click(query.getByRole('button', { name: 'Prepare request' }));
    await query.findByRole('heading', { name: 'Ready for request review' });
    if (query.queryByRole('heading', { name: 'Ready checks passed' })) throw Error('Review eligibility must not claim DoR passed.');
    if ((query.getByRole('button', { name: 'Mark ready and publish' }) as HTMLButtonElement).disabled) throw Error('An eligible review request should offer explicit publication.');
    if (!canvasElement.textContent?.includes('Implementation waits for that review and the Definition of Ready checks.')) throw Error('The review boundary must be clear.');
    await ready(canvasElement);
  },
};


export const SelectRequestModel: Story = {
  name: 'Choose a model and keep its selection in the shared draft',
  parameters: { storymap: { ...storymap('Provider and model overrides are stored on the same Markdown Feature Request and remain editable before publication.', true), covers: [...storymap('', true).covers, 'src/worker/webview/components/ModelSelectionFields.vue'] } },
  render,
  play: async ({ canvasElement }) => {
    const query = within(canvasElement);
    await userEvent.type(query.getByLabelText('Request instructions', { exact: true }), 'Add CSV export to orders.');
    await userEvent.click(query.getByText('Request options', { exact: true }));
    await userEvent.type(query.getByLabelText('Model · optional', { exact: true }), 'team-selected-model');
    await userEvent.click(query.getByRole('button', { name: 'Prepare request' }));
    await query.findByLabelText('Context', { exact: true });
    await userEvent.click(query.getByText('Execution options', { exact: false }));
    await userEvent.click(query.getByText('Provider, model & effort', { exact: true }));
    const model = query.getByLabelText('Model · optional', { exact: true }) as HTMLInputElement;
    if (model.value !== 'team-selected-model') throw Error('Prepared Markdown lost its explicit model selection.');
    await userEvent.clear(model); await userEvent.type(model, 'reviewed-model');
    if (!canvasElement.textContent?.includes('Details changed · check again')) throw Error('Model edits must require readiness validation again.');
    await ready(canvasElement);
  },
};


export const NewRequestUsesUpdatedDefaults: Story = {
  name: 'A new shared request uses current worker defaults',
  parameters: { storymap: storymap('Current defaults apply to a fresh request while an active draft keeps its selected model and provider.', true) },
  render,
  play: async ({ canvasElement }) => {
    const query = within(canvasElement);
    await userEvent.click(query.getByText('Request options', { exact: true }));
    state.settings!.defaultProvider = 'claude-cli'; await nextTick();
    if (!query.getByLabelText('Provider', { exact: true }).textContent?.includes('Claude')) throw Error('Untouched draft did not adopt current default.');
    await userEvent.type(query.getByLabelText('Request instructions', { exact: true }), 'Add CSV export.');
    await userEvent.type(query.getByLabelText('Model · optional', { exact: true }), 'draft-model');
    state.settings!.defaultProvider = 'codex-cli'; await nextTick();
    if (!query.getByLabelText('Provider', { exact: true }).textContent?.includes('Claude')) throw Error('Refresh changed an active draft.');
    await userEvent.click(query.getByRole('button', { name: 'Prepare request' }));
    await query.findByLabelText('Context', { exact: true });
    await userEvent.click(query.getByRole('button', { name: 'Discard unpublished edits' }));
    await userEvent.click(query.getByText('Request options', { exact: true }));
    if (!query.getByLabelText('Provider', { exact: true }).textContent?.includes('Codex')) throw Error('New request retained the previous provider.');
    if ((query.getByLabelText('Model · optional', { exact: true }) as HTMLInputElement).value) throw Error('New request retained a previous model override.');
    if (!query.getByLabelText('Effort', { exact: true }).textContent?.includes('Inherit')) throw Error('New request retained a previous effort.');
    await ready(canvasElement);
  },
};
