import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { userEvent, within } from 'storybook/test';
import { h, KeepAlive, nextTick, type Component } from 'vue';
import UApp from '@nuxt/ui/components/App.vue';
import TaskInteraction from '../src/worker/webview/components/TaskInteraction.vue';
import Taskboard from '../src/worker/webview/components/Taskboard.vue';
import RepositoryPanel from '../src/worker/webview/components/RepositoryPanel.vue';
import { installPreparationFixture, installWorktreeLocationFixture, installWorktreeDeletionFixture } from './worker-preparation-fixtures';

const meta = { title: 'Worker/Request preparation', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
const requestComponents = ['TaskInteraction', 'TaskIntake', 'RunTask'];
const storymap = (summary: string, components: string[], route = '/taskboard') => ({ app: 'Worker', summary, covers: components.map(name => 'src/worker/webview/components/' + name + '.vue'), route, ready: '[data-preparation-ready]' });
function render(component: Component, install: () => unknown) {
  return () => ({ setup() {
    install();
    return () => h(UApp, null, { default: () => h('div', { style: 'max-width:1050px;margin:auto;padding:24px;min-width:0' }, [h('p', { class: 'page-note' }, 'Illustrative example · no Git or model execution'), h(KeepAlive, null, { default: () => h(component) })]) });
  } });
}
async function until(assertion: () => boolean, message: string) {
  for (let attempt = 0; attempt < 150; attempt++) { if (assertion()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error(message);
}
async function ready(canvas: HTMLElement) { await nextTick(); canvas.setAttribute('data-preparation-ready', 'true'); }
async function submit(canvas: HTMLElement) {
  const query = within(canvas);
  await userEvent.type(query.getByLabelText('Request instructions', { exact: true }), 'Improve the project documentation and verify the result.');
  await userEvent.click(canvas.querySelector('.repository-options > summary')!);
  await userEvent.click(query.getByLabelText('Allow changes to approved repository files', { exact: true }));
  await userEvent.type(query.getByLabelText('Approved files · one relative path per line', { exact: true }), 'README.md');
  await userEvent.click(query.getByRole('button', { name: /^Create request$/ }));
  await until(() => canvas.textContent?.includes('Preparing this request’s Git worktree') === true, 'The unified composer must show worktree preparation.');
}
export const PreparingRequest: Story = {
  name: 'Keep instructions visible while preparing a request',
  parameters: { storymap: storymap('The unified composer retains the exact request while Git worktree preparation runs. Progress is separate from durable acceptance, and existing-task controls stay available.', requestComponents) },
  render: render(TaskInteraction, () => installPreparationFixture()),
  play: async ({ canvasElement }) => {
    await submit(canvasElement);
    const query = within(canvasElement);
    if (!(query.getByLabelText('Request instructions') as HTMLTextAreaElement).value.includes('Improve the project documentation')) throw Error('Preparation must retain the original input.');
    if ((query.getByRole('tab', { name: /^Follow up$/ }) as HTMLButtonElement).disabled) throw Error('Preparation must not lock other task interaction.');
    await ready(canvasElement);
  },
};
export const FailedPreparation: Story = {
  name: 'Recover a failed preparation with the same request',
  parameters: { storymap: storymap('A failed Git preparation keeps the instructions and approved files. An explicit retry uses the same operation; polling cannot create another request.', requestComponents) },
  render: render(TaskInteraction, () => installPreparationFixture(true)),
  play: async ({ canvasElement }) => {
    await submit(canvasElement);
    await within(canvasElement).findByRole('button', { name: /^Retry same request$/ });
    if (!canvasElement.textContent?.includes('repository is locked')) throw Error('The preparation failure must explain what to resolve.');
    const fixture = (window as unknown as { __WERK_PREPARATION_FIXTURE__: { creates: unknown[] } }).__WERK_PREPARATION_FIXTURE__;
    if (fixture.creates.length !== 1) throw Error('Observation cannot automatically resubmit creation.');
    await ready(canvasElement);
  },
};
export const KeepCurrentInteraction: Story = {
  name: 'Keep working while another request is prepared',
  parameters: { storymap: storymap('An operator can return to the active task while another request prepares. Completion offers the saved request without replacing the task being inspected.', requestComponents) },
  render: render(TaskInteraction, () => installPreparationFixture()),
  play: async ({ canvasElement }) => {
    await submit(canvasElement);
    const query = within(canvasElement);
    await userEvent.click(query.getByRole('tab', { name: /^Follow up$/ }));
    const stop = await query.findByRole('button', { name: /^Stop task$/ });
    if ((stop as HTMLButtonElement).disabled) throw Error('The active task must remain stoppable during preparation.');
    (window as unknown as { __WERK_PREPARATION_FIXTURE__: { finish(): void } }).__WERK_PREPARATION_FIXTURE__.finish();
    await query.findByRole('link', { name: /^Open saved request$/ });
    if (!canvasElement.querySelector('#chat-task-title')?.textContent?.includes('Validate worker restart behavior')) throw Error('Preparation completion must preserve the task being inspected.');
    await ready(canvasElement);
  },
};
export const WorktreeLocation: Story = {
  name: 'Choose a separate folder for task worktrees',
  parameters: { storymap: storymap('The repository editor shows an optional absolute worktree folder outside all checkouts. Existing worktrees remain at their original location.', ['RepositoryPanel'], '/settings#repositories') },
  render: render(RepositoryPanel, installWorktreeLocationFixture),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByText('Manage repository assignments', { exact: true }));
    const directory = canvasElement.querySelector<HTMLInputElement>('#repository-worktree-directory');
    if (directory?.value !== '/example/worktrees') throw Error('The saved worktree directory must be visible.');
    await ready(canvasElement);
  },
};
export const RequiredWorktreeCleanup: Story = {
  name: 'Keep a task when its worktree cannot be removed safely',
  parameters: { storymap: storymap('Deletion defaults to required safe cleanup. A changed worktree stops deletion, retains the task and explains how to keep the files deliberately.', ['Taskboard'], '/history?fileId=file-review') },
  render: render(Taskboard, installWorktreeDeletionFixture),
  play: async ({ canvasElement }) => {
    const query = within(canvasElement);
    await userEvent.click(await query.findByRole('button', { name: /^Delete$/ }));
    const checkbox = query.getByRole('checkbox', { name: /Also remove its Git worktree/ }) as HTMLInputElement;
    if (!checkbox.checked) throw Error('Every new deletion must default to required cleanup.');
    await userEvent.click(query.getByRole('button', { name: /^Confirm deletion$/ }));
    await until(() => canvasElement.textContent?.includes('Uncheck worktree removal') === true, 'Safe cleanup refusal must stay visible.');
    if (!canvasElement.querySelector('#local-task-detail') || !checkbox.checked) throw Error('A refused deletion must retain the task and confirmation.');
    await ready(canvasElement);
  },
};
