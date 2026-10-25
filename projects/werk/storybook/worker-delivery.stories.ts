import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { h, nextTick } from 'vue';
import { userEvent, waitFor, within } from 'storybook/test';
import UApp from '@nuxt/ui/components/App.vue';
import ReviewPage from '../src/worker/webview/pages/ReviewPage.vue';
import { installDeliveryFixture, type DeliveryFixture } from './worker-delivery-fixtures';
const meta = { title: 'Worker/Local delivery', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
let fixture: ReturnType<typeof installDeliveryFixture>;
const storymap = (summary: string, review = false) => ({ app: 'Worker', summary, covers: ['pages/ReviewPage', 'components/DeliveryRunPanel', 'components/DeliveryControls', 'components/RequestActivityPanel', ...(review ? ['components/DeliveryReviewEvidence', 'components/DeliveryHumanReview'] : [])].map(name => 'src/worker/webview/' + name + '.vue'), route: '/review?session=file&fileId=file-review', ready: '[data-delivery-ready]' });
function render(variant: DeliveryFixture) { return () => ({ setup() {
  fixture = installDeliveryFixture(variant);
  return () => h(UApp, null, { default: () => h('main', { style: 'padding:24px;max-width:1280px;margin:auto;min-width:0' }, [h('p', { class: 'page-note' }, 'Illustrative local delivery · no model, command, Git change or review occurred'), h(ReviewPage)]) });
} }); }
async function loaded(canvas: HTMLElement) { await waitFor(() => { if (!canvas.querySelector('.delivery-controls')) throw Error('Waiting for delivery controls.'); }); }
async function ready(canvas: HTMLElement) { await nextTick(); if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) throw Error('Local delivery view overflows.'); canvas.setAttribute('data-delivery-ready', 'true'); }
export const RunningDelivery: Story = {
  name: 'Inspect the current phase and its next event',
  parameters: { storymap: storymap('The Feature Request lifecycle, delivery run status and current phase stay separate. Behavior conditions and recorded steps explain the next action without a fabricated progress percentage.') }, render: render('running'),
  play: async ({ canvasElement }) => { await loaded(canvasElement); const query = within(canvasElement); await query.findByText('Current phase'); if (!canvasElement.textContent?.includes('The current implementation step to finish.')) throw Error('Next expected event missing.'); await userEvent.click(query.getByText('Why the worker chose this action')); await ready(canvasElement); },
};
export const PauseAtBoundary: Story = {
  name: 'Pause is pending until the active step finishes',
  parameters: { storymap: storymap('A guarded pause command preserves the exact delivery run and revision. The interface distinguishes recorded intent from a completed pause, then offers explicit resume.') }, render: render('running'),
  play: async ({ canvasElement }) => {
    await loaded(canvasElement); const query = within(canvasElement);
    await userEvent.click(query.getByRole('button', { name: 'Pause after this step' }));
    await waitFor(() => { if (!canvasElement.textContent?.includes('Pause requested')) throw Error('Pause receipt not visible.'); });
    const command = fixture.mutations[0]; if (command.deliveryRunId !== fixture.run.id || command.inputRevision !== 1 || !command.operationId) throw Error('Pause lost its exact run and revision.');
    if (query.queryByRole('button', { name: 'Resume work' })) throw Error('Pending pause cannot be reported as paused.');
    fixture.finishStep(); await query.findByRole('button', { name: 'Resume work' }); await ready(canvasElement);
  },
};
export const UnknownOutcome: Story = {
  name: 'Unknown outcome does not silently dispatch another attempt',
  parameters: { storymap: storymap('A process whose completion is unknown remains explicit, with retained step correlation and no unsupported resume or retry action.') }, render: render('unknown'),
  play: async ({ canvasElement }) => { await loaded(canvasElement); const query = within(canvasElement); if (!canvasElement.textContent?.includes('Outcome unknown')) throw Error('Unknown outcome missing.'); if (canvasElement.textContent?.includes('The worker is running with its accepted scope.')) throw Error('A legacy invocation must not contradict the canonical unknown delivery.'); if (query.queryByRole('button', { name: /Resume work|Retry failed work|Record acceptance/ })) throw Error('Unsafe continuation or acceptance control exposed.'); await query.findByText('Retained model output. This reply is not a confirmed result for the current delivery run.'); const retained = await query.findByText('Retained delivery review package'); const packageElement = canvasElement.querySelector('.delivery-review-evidence')!; const disclosure = retained.closest('details'); if (!disclosure || disclosure.open || !disclosure.contains(packageElement) || packageElement.getClientRects().length || packageElement.checkVisibility()) throw Error('An earlier run’s package cannot appear as current review evidence.'); await userEvent.click(retained); await waitFor(() => { if (!packageElement.checkVisibility()) throw Error('Retained package did not open for inspection.'); }); await userEvent.click(retained); if (packageElement.checkVisibility()) throw Error('The retained package must close without becoming current evidence.'); await ready(canvasElement); },
};
export const ConfirmStoppedProcess: Story = {
  name: 'Confirm a stopped process before explicitly resuming',
  parameters: { storymap: storymap('Recovery requires the operator to inspect and stop remaining processes, acknowledge that inspection, and record a note. Confirmation remains separate from resume.') }, render: render('unknown'),
  play: async ({ canvasElement }) => {
    await loaded(canvasElement); const query = within(canvasElement), submit = query.getByRole('button', { name: 'Record stopped-process confirmation' }) as HTMLButtonElement;
    if (!submit.disabled) throw Error('Unknown process recovery needs an explicit acknowledgement.');
    await userEvent.type(query.getByLabelText('What you inspected and stopped'), 'Inspected the prior Claude process and the owned worktree; no model or command processes remain.');
    if (!submit.disabled) throw Error('A note alone cannot acknowledge that the operator stopped the processes.');
    await userEvent.click(query.getByRole('checkbox', { name: 'I inspected and stopped any remaining processes for this delivery run.' }));
    await userEvent.click(submit); await query.findByRole('button', { name: 'Resume work' });
    const command = fixture.mutations[0];
    if (command.action !== 'confirm_stopped' || command.deliveryRunId !== fixture.run.id || command.inputRevision !== 1 || !command.note || !command.operationId) throw Error('Recovery lost its operator observation or exact run identity.');
    if (fixture.mutations.some(command => command.action === 'resume')) throw Error('Recording recovery must not automatically resume.');
    await userEvent.click(await query.findByText('Retained Git checkpoints · 1'));
    await query.findByText('werk/checkpoints/FR-42-stopped');
    if (!canvasElement.textContent?.includes('A checkpoint does not establish passed checks or human acceptance.')) throw Error('A retained checkpoint must not be presented as verified.');
    const stages = ['produce', 'verify', 'review'].map(id => canvasElement.querySelector(`[data-workflow-stage="${id}"]`));
    if (stages.some(stage => !stage || stage.classList.contains('workflow-complete'))) throw Error('Historical results must not mark the interrupted delivery stages complete.');
    if (canvasElement.querySelector('[data-workflow-stage=merge], [data-workflow-stage=build], [data-workflow-stage=publish]')) throw Error('Plain Git must not require unconfigured GitHub release stages.');
    await query.findByText('Retained task candidate evidence');
    await query.findByText('Retained model output. This reply is not a confirmed result for the current delivery run.');
    if (query.queryByRole('button', { name: /Check readiness and queue work|Evaluate readiness rules|Evaluate completion rules|Ask model for an instruction proposal/ })) throw Error('Delivery recovery must only expose exact delivery continuation controls.');
    await userEvent.click(query.getByText('Operator process confirmations · 1'));
    await query.findByText('Operator-attested stop');
    await ready(canvasElement);
  },
};
export const LostAcknowledgement: Story = {
  name: 'Retry a saved control without duplicating the command',
  parameters: { storymap: storymap('An uncertain HTTP acknowledgement keeps the original operation ID. Retrying confirms the saved pause instead of submitting another command.') }, render: render('lost-ack'),
  play: async ({ canvasElement }) => {
    await loaded(canvasElement); const query = within(canvasElement); await userEvent.click(query.getByRole('button', { name: 'Pause after this step' }));
    await userEvent.click(await query.findByRole('button', { name: 'Retry saved action' }));
    await waitFor(() => { if (fixture.mutations.length !== 2) throw Error('Retry has not returned.'); });
    if (JSON.stringify(fixture.mutations[0]) !== JSON.stringify(fixture.mutations[1])) throw Error('Uncertain acknowledgement changed the command.');
    await ready(canvasElement);
  },
};
export const HumanCriterionReview: Story = {
  name: 'Accept only after reviewing each required human criterion',
  parameters: { storymap: storymap('A local candidate commit and its criterion matrix precede the review decision. Every required human criterion needs a passing observation; the command binds the candidate and never implies a remote PR or merge.', true) }, render: render('review'),
  play: async ({ canvasElement }) => {
    await loaded(canvasElement); const query = within(canvasElement), submit = await query.findByRole('button', { name: 'Record acceptance' });
    await userEvent.type(query.getByLabelText('Review note'), 'Reviewed equal-date ordering and the retained check evidence.');
    if (!(submit as HTMLButtonElement).disabled) throw Error('General acceptance text cannot pass an unreviewed human criterion.');
    await userEvent.selectOptions(query.getByLabelText('Review outcome'), 'passed');
    await userEvent.type(query.getByLabelText('What you checked or what needs to change'), 'Created three equal-date requests and confirmed their original order is preserved.');
    await userEvent.click(submit); await query.findByText('Acceptance recorded for this result');
    const command = fixture.mutations.at(-1)!; if (command.candidateCommit !== fixture.review.candidate.candidateCommit || !command.humanOutcomes) throw Error('Acceptance lost candidate-scoped human outcomes.');
    await ready(canvasElement);
  },
};
export const ReviewDraftSurvivesRefresh: Story = {
  name: 'Human observations and keyboard focus survive quiet refresh',
  parameters: { storymap: storymap('The candidate-scoped observation draft remains in the same field during polling, so reviewing evidence does not interrupt typing.', true) }, render: render('review'),
  play: async ({ canvasElement }) => {
    await loaded(canvasElement); const query = within(canvasElement), input = query.getByLabelText('What you checked or what needs to change') as HTMLTextAreaElement;
    await userEvent.type(input, 'Inspecting equal-date behavior.'); input.focus(); fixture.refreshObservation(); const observation = await query.findByText('An updated worker observation; your review draft is retained.', { exact: false, selector: '.delivery-run > p' }); if (!observation.checkVisibility()) throw Error('The current observation must be visible outside the inspector.');
    if (query.getByLabelText('What you checked or what needs to change') !== input || input.value !== 'Inspecting equal-date behavior.' || document.activeElement !== input) throw Error('Quiet refresh disrupted the human review draft.');
    await ready(canvasElement);
  },
};
export const FilterActivity: Story = {
  name: 'Trace request events and delivery steps',
  parameters: { storymap: storymap('The worker journal is ordered and filterable by event, phase, invocation or revision. Recorded step output is separate from command acknowledgements.') }, render: render('running'),
  play: async ({ canvasElement }) => { await loaded(canvasElement); const query = within(canvasElement); await query.findByText('delivery started'); await userEvent.type(query.getByLabelText('Filter activity by event, phase, run or revision'), 'delivery'); if (canvasElement.querySelectorAll('.activity-events > li').length !== 1) throw Error('Activity filter did not keep the matching delivery event.'); await ready(canvasElement); },
};
