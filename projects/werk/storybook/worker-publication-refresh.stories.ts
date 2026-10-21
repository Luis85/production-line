import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { h, nextTick, reactive } from 'vue';
import UApp from '@nuxt/ui/components/App.vue';
import { userEvent, waitFor, within } from 'storybook/test';
import DeliveryPublicationPanel from '../src/worker/webview/components/DeliveryPublicationPanel.vue';
import { installExpandedDeliveryFixture } from './worker-expanded-delivery-fixtures';

const meta = { title: 'Worker/Publication refresh', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
function createFixture() {
  const base = installExpandedDeliveryFixture(), subject = reactive(base.request);
  base.publication.canPush = false; base.publication.canCreatePullRequest = false;
  base.publication.publications = [{ operationId: 'retained-publication', action: 'pull_request', candidate: base.review.candidate, target: base.policy.configuration.remoteDelivery!, repositoryId: 'web', configurationDigest: base.policy.configurationDigest, status: 'unknown', createdAt: base.request.createdAt, updatedAt: base.request.updatedAt, detail: 'The original remote operation is retained. Reconcile it before publishing again.' }];
  const globals = window as unknown as { __WERK_STORY_FETCH__: typeof fetch }, original = globals.__WERK_STORY_FETCH__;
  let held: { promise: Promise<boolean>; started: boolean } | null = null;
  globals.__WERK_STORY_FETCH__ = async (input, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (body.action === 'publication' && held) {
      const current = held; held = null; current.started = true;
      if (await current.promise) return Response.json({ error: 'Publication policy could not be refreshed.' }, { status: 503 });
    }
    return original(input, init);
  };
  return { ...base, subject, holdNextRead() { let release!: (failed: boolean) => void; const read = { promise: new Promise<boolean>(resolve => { release = resolve; }), started: false }; held = read; return { started: () => read.started, release }; } };
}
let fixture: ReturnType<typeof createFixture>;
const storymap = { app: 'Worker', summary: 'Same-request revision changes retain readable publication receipts and disclosure state while actions wait for current policy. Failed refresh keeps the last evidence and offers explicit recovery.', route: '/review?session=file&fileId=file-review', covers: ['src/worker/webview/components/DeliveryPublicationPanel.vue'], ready: '[data-publication-refresh-ready]' };
const render = () => ({ setup() {
  fixture = createFixture();
  return () => h(UApp, null, { default: () => h('main', { style: 'padding:24px;max-width:1150px;margin:auto;min-width:0' }, [h('p', { class: 'page-note' }, 'Illustrative publication · no remote operation occurs'), h(DeliveryPublicationPanel, { subject: fixture.subject, disabled: false, pending: () => false, onCommand: fixture.command })]) });
} });
async function exercise(canvas: HTMLElement, fail: boolean) {
  const query = within(canvas), summary = await query.findByText('Publication identity', { exact: true });
  await userEvent.click(summary); summary.focus();
  const details = summary.closest('details')!, history = canvas.querySelector('.publication-history')!;
  const reconcile = query.getByRole('button', { name: 'Reconcile this publication' }) as HTMLButtonElement;
  if (!details.open || reconcile.disabled) throw Error('The initial publication must be inspectable and eligible for reconciliation.');
  const held = fixture.holdNextRead(); fixture.subject.revision++;
  await waitFor(() => { if (!held.started()) throw Error('Revision revalidation did not start.'); });
  await nextTick();
  if (canvas.querySelector('.publication-history') !== history || !details.open || document.activeElement !== summary) throw Error('A quiet revision replaced history, closed its disclosure or lost keyboard focus.');
  if (!reconcile.disabled) throw Error('Old publication policy cannot authorize a new request revision.');
  reconcile.click(); if (fixture.mutations.length) throw Error('Revalidation must not dispatch a command.');
  held.release(fail);
  if (fail) {
    await query.findByRole('alert');
    if (canvas.querySelector('.publication-history') !== history || !details.open || !reconcile.disabled) throw Error('Failed revalidation lost retained evidence or enabled a decision.');
    await userEvent.click(query.getByRole('button', { name: 'Refresh publication' }));
  }
  await waitFor(() => { if (reconcile.disabled) throw Error('Current policy did not restore eligible reconciliation.'); });
  if (canvas.querySelector('.publication-history') !== history || !details.open || fixture.mutations.length) throw Error('Refresh recovery remounted history or dispatched remote work.');
  canvas.setAttribute('data-publication-refresh-ready', 'true');
}
export const QuietRevisionRefresh: Story = { name: 'Keep publication history while a request changes', parameters: { storymap }, render, play: async ({ canvasElement }) => exercise(canvasElement, false) };
export const FailedRevisionRefresh: Story = { name: 'Retain publication evidence after a failed refresh', parameters: { storymap }, render, play: async ({ canvasElement }) => exercise(canvasElement, true) };
