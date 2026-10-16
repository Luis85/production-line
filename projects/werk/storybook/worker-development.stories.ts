import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { h, nextTick, type Component } from 'vue';
import UApp from '@nuxt/ui/components/App.vue';
import CandidateEvidence from '../src/worker/webview/components/CandidateEvidence.vue';
import TaskInteraction from '../src/worker/webview/components/TaskInteraction.vue';
import ToolAccessPanel from '../src/worker/webview/components/ToolAccessPanel.vue';
import DurationSettingsPanel from '../src/worker/webview/components/DurationSettingsPanel.vue';
import { installDevelopmentFixture, type DevelopmentFixture } from './worker-development-fixtures';
const meta = { title: 'Worker/Implementation', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
let fixture: ReturnType<typeof installDevelopmentFixture>;
const storymap = (summary: string, covers: string[], route = '/taskboard') => ({ app: 'Worker', summary, covers: covers.map(name => 'src/worker/webview/components/' + name + '.vue'), route, ready: '[data-development-ready]' });
function render(component: Component, variant: DevelopmentFixture, taskProp = false) {
  return () => ({ setup() {
    fixture = installDevelopmentFixture(variant);
    return () => h(UApp, null, { default: () => h('div', { style: 'max-width:1050px;margin:auto;padding:24px;min-width:0' }, [h('p', { class: 'page-note' }, 'Illustrative example · no model call or verification command was run'), h(component, taskProp ? { task: fixture.task } : {})]) });
  } });
}
async function ready(canvas: HTMLElement) { await nextTick(); canvas.setAttribute('data-development-ready', 'true'); }
async function evidence({ canvasElement }: { canvasElement: HTMLElement }) {
  await nextTick(); const details = canvasElement.querySelector<HTMLDetailsElement>('.candidate-details'); if (!details) throw Error('Candidate evidence is missing'); details.open = true;
  const output = canvasElement.querySelector<HTMLDetailsElement>('.check-output'); if (output) output.open = true;
  await ready(canvasElement);
}
export const CheckedCandidate: Story = { name: 'Implemented candidate awaits human review', parameters: { storymap: storymap('Only matching successful required checks verify this recorded candidate. Human review and merge remain separate.', ['CandidateEvidence']) }, render: render(CandidateEvidence, 'passed', true), play: evidence };
export const FailedCheck: Story = { name: 'Failed required check blocks handoff', parameters: { storymap: storymap('A failed check keeps its exit code and readable output visible, with approved and changed paths for repair.', ['CandidateEvidence']) }, render: render(CandidateEvidence, 'failed', true), play: evidence };
export const OutdatedChecks: Story = { name: 'Changed candidate needs checks rerun', parameters: { storymap: storymap('Results for a previous candidate cannot verify newly changed files, even when their earlier status was passed.', ['CandidateEvidence']) }, render: render(CandidateEvidence, 'stale', true), play: evidence };
export const ProposalOnly: Story = { name: 'Retained proposal is not an implementation', parameters: { storymap: storymap('Older proposal-only requests keep their original authority and do not acquire implementation claims from current grants.', ['CandidateEvidence']) }, render: render(CandidateEvidence, 'proposal', true), play: evidence };
export const ImplementationIntake: Story = { name: 'Approve files in the existing request composer', parameters: { storymap: storymap('The same request composer shows implementation eligibility, exact approved paths and saved required checks without adding a task type.', ['TaskInteraction', 'TaskIntake', 'RunTask']) }, render: render(TaskInteraction, 'passed'), play: async ({ canvasElement }) => {
  await nextTick(); const instructions = canvasElement.querySelector<HTMLTextAreaElement>('#new-task-instructions')!; instructions.value = 'Sort requests by creation time and add acceptance tests for equal dates.'; instructions.dispatchEvent(new Event('input', { bubbles: true })); (canvasElement.querySelector('.repository-options > summary') as HTMLElement).click();
  (canvasElement.querySelector('#request-file-changes') as HTMLInputElement).click();
  const paths = canvasElement.querySelector<HTMLTextAreaElement>('#local-paths'); await nextTick();
  const input = paths ?? canvasElement.querySelector<HTMLTextAreaElement>('#local-paths'); if (!input) throw Error('Approved paths missing'); input.value = 'src/requests.ts\ntest/requests.test.ts'; input.dispatchEvent(new Event('input', { bubbles: true }));
  await ready(canvasElement);
} };
export const RequiredCheckSetup: Story = { name: 'Mark a command as a required feature check', parameters: { storymap: storymap('File access and enabled required checks make new Git requests eligible for implementation. Unmarked presets stay ordinary tools.', ['ToolAccessPanel', 'CliToolsEditor', 'McpConnectionsEditor'], '/settings#tool-access') }, render: render(ToolAccessPanel, 'setup'), play: async ({ canvasElement }) => ready(canvasElement) };
const budgetPlay = async ({ canvasElement }: { canvasElement: HTMLElement }) => { await nextTick(); const details = canvasElement.querySelector<HTMLDetailsElement>('.tool-budget-options'); if (!details) throw Error('Tool budgets missing'); details.open = true; await ready(canvasElement); };
export const ExecutionBudgets: Story = { name: 'Bound tool calls and command duration', parameters: { storymap: storymap('Tool budgets are saved atomically with duration settings and do not grant additional permissions.', ['DurationSettingsPanel'], '/settings#queue') }, render: render(DurationSettingsPanel, 'budget'), play: budgetPlay };
export const EnvironmentDuration: Story = { name: 'Environment maximum preserves editable tool budgets', parameters: { storymap: storymap('The environment-controlled attempt maximum is read-only while warning, call limit and command timeout remain editable.', ['DurationSettingsPanel'], '/settings#queue') }, render: render(DurationSettingsPanel, 'budget-environment'), play: budgetPlay };
export const StaleBudgetDraft: Story = { name: 'Concurrent budget save retains the unsaved draft', parameters: { storymap: storymap('A changed saved budget blocks a stale form without discarding its input; the operator can explicitly reload.', ['DurationSettingsPanel'], '/settings#queue') }, render: render(DurationSettingsPanel, 'budget'), play: async context => {
  await budgetPlay(context); const input = context.canvasElement.querySelector<HTMLInputElement>('#execution-tool-calls')!; input.value = '64'; input.dispatchEvent(new Event('input', { bubbles: true })); await nextTick(); fixture.changeSavedBudget(256); await nextTick();
  if (input.value !== '64' || !context.canvasElement.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled) throw Error('Concurrent changes must retain and block the stale draft'); await ready(context.canvasElement);
} };
