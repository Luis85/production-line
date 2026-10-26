import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { h, nextTick, ref, type VNodeChild } from 'vue';
import { userEvent, within } from 'storybook/test';
import ManagedProjectsPanel from '../src/worker/webview/components/ManagedProjectsPanel.vue';
import FeatureTemplateSelection from '../src/worker/webview/components/FeatureTemplateSelection.vue';
import { installManagedProjectsFixture } from './worker-release-fixtures';
const meta = { title: 'Worker/Workflow recovery', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
let projects: ReturnType<typeof installManagedProjectsFixture>;
let completeRegistration: (() => void) | undefined;
const storymap = (summary: string, component = 'ManagedProjectsPanel') => ({ app: 'Worker', summary, covers: ['src/worker/webview/components/' + component + '.vue'], route: '/settings#repositories', ready: '[data-workflow-polish-ready]' });
async function ready(canvas: HTMLElement) { await nextTick(); if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) throw Error('Workflow recovery overflowed.'); canvas.setAttribute('data-workflow-polish-ready', 'true'); }
const frame = (children: VNodeChild[]) => h('main', { style: 'max-width:1000px;margin:auto;padding:24px;min-width:0' }, children);
export const HeldProjectSetup: Story = {
  name: 'Recheck a prepared project after policy approval',
  parameters: { storymap: storymap('Prepared checkouts keep an explicit setup action while intake is blocked. Long project names and paths wrap without hiding approval guidance.') },
  render: () => ({ setup() {
    projects = installManagedProjectsFixture();
    const project = projects.projects.projects[0]!;
    project.name = 'InternationalCustomerPortal'.repeat(4); project.path = 'C:\\Werk\\projects\\' + 'international-customer-portal-'.repeat(3) + '\\checkout';
    project.intakeEnabled = true; project.policyApproved = false; project.intakeBlockedReason = 'The configured intake is held because this exact committed delivery policy needs local approval.';
    return () => frame([h('p', { class: 'page-note' }, 'Illustrative held project · no repository operation is performed.'), h(ManagedProjectsPanel)]);
  } }),
  play: async ({ canvasElement }) => {
    const q = within(canvasElement); await q.findByText('The configured intake is held because this exact committed delivery policy needs local approval.');
    if (q.queryByText('Request intake enabled.', { exact: false })) throw Error('Configured intake must not imply current approval.');
    const recheck = await q.findByRole('button', { name: 'Recheck project setup' }); await userEvent.click(recheck);
    await q.findByText('Project operation recorded. Review the saved project status below.');
    if (projects.commands[0]?.action !== 'reconcile' || projects.commands[0]?.id !== 'web') throw Error('Project setup action did not reconcile the retained project.');
    await ready(canvasElement);
  },
};
export const RegistrationInProgress: Story = {
  name: 'Keep a running registration distinct from an uncertain response',
  parameters: { storymap: storymap('A pending worker request reports active preparation. Only an unconfirmed response exposes retrying the exact saved operation.') },
  render: () => ({ setup() {
    projects = installManagedProjectsFixture(); completeRegistration = undefined;
    const original = (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__;
    (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname === '/api/managed-projects' && init.method === 'POST') return new Promise<Response>(resolve => { completeRegistration = () => resolve(Response.json(projects.projects)); });
      return original(input, init);
    };
    return () => frame([h('p', { class: 'page-note' }, 'Illustrative pending registration · no repository is cloned.'), h(ManagedProjectsPanel)]);
  } }),
  play: async ({ canvasElement }) => {
    const q = within(canvasElement); await q.findByText('Customer portal'); await userEvent.click(q.getByText('Add a project', { exact: true }));
    await userEvent.type(q.getByLabelText('Project ID'), 'api'); await userEvent.type(q.getByLabelText('Git repository URL'), 'https://github.com/example/api.git');
    await userEvent.click(q.getByRole('button', { name: 'Clone and add project' })); await q.findByText('Cloning and registering the project… Wait for the worker’s recorded result.');
    if (q.queryByRole('button', { name: 'Retry saved operation' })) throw Error('A still-running operation must not claim an uncertain acknowledgement.');
    completeRegistration?.(); await q.findByText('Project operation recorded. Review the saved project status below.'); await ready(canvasElement);
  },
};
export const RetryTemplateRead: Story = {
  name: 'Retry a failed project template read in place',
  parameters: { storymap: storymap('A failed template lookup retains the selected template. The local retry reloads the same project and restores its committed choices.', 'FeatureTemplateSelection') },
  render: () => ({ setup() {
    installManagedProjectsFixture(); const selected = ref('bug'), original = (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__; let attempts = 0;
    (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname === '/api/features/templates') return ++attempts === 1 ? Response.json({ error: 'The project template lookup is temporarily unavailable.' }, { status: 503 }) : Response.json({ projectId: 'web', configured: true, defaultTemplateId: 'feature', templates: [{ id: 'feature', label: 'Feature', path: 'features/_templates/feature.md', default: true }, { id: 'bug', label: 'Bug report', path: 'features/_templates/bug.md', default: false }] });
      return original(input, init);
    };
    return () => frame([h('p', { class: 'page-note' }, 'Illustrative failed lookup · no request is prepared.'), h(FeatureTemplateSelection, { id: 'recovery', projectId: 'web', modelValue: selected.value, disabled: false, 'onUpdate:modelValue': (value: string) => { selected.value = value; } })]);
  } }),
  play: async ({ canvasElement }) => {
    const q = within(canvasElement); await userEvent.click(await q.findByRole('button', { name: 'Retry loading templates' }));
    await q.findByText('features/_templates/bug.md · committed project template');
    if ((q.getByLabelText('Feature Request template') as HTMLSelectElement).value !== 'bug') throw Error('Template retry replaced the selected project template.');
    await ready(canvasElement);
  },
};
