import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { h } from 'vue';
import { userEvent, within } from 'storybook/test';
import ExecutionRecoveryPanel from '../src/worker/webview/components/ExecutionRecoveryPanel.vue';
import { installExpandedDeliveryFixture } from './worker-expanded-delivery-fixtures';
import type { WorkerRun } from '../src/worker/application/run-evidence';
import { fixtureTime } from './worker-fixtures';
const meta = { title: 'Worker/Execution recovery', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
let commands: Record<string, unknown>[] = [];
export const UncertainReviewerStop: Story = {
  name: 'Confirm an inspected auxiliary process without replaying work',
  parameters: { storymap: { app: 'Worker', summary: 'An unresolved readiness reviewer keeps capacity reserved. Explicit operator inspection records an exact run/revision receipt; an uncertain response retries the same operation and does not dispatch or resume work.', covers: ['src/worker/webview/components/ExecutionRecoveryPanel.vue'], route: '/taskboard', ready: '[data-execution-recovery-ready]' } },
  render: () => ({ setup() {
    installExpandedDeliveryFixture(); commands = [];
    const run = { id: '11111111-1111-4111-8111-111111111111', sessionId: 'ready-review-FR42', title: 'Ready Check: Stable ordering', purpose: 'gate_review', provider: 'claude-cli', model: 'claude-example', startedAt: fixtureTime, executionRecovery: { schemaVersion: 1, revision: 2, state: 'unknown', reason: 'process_stop_unconfirmed', detectedAt: fixtureTime } } as WorkerRun;
    const previous = (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__;
    (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href), body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
      if (url.pathname === '/api/requests' && body.action === 'execution_recovery') return Response.json({ schemaVersion: 1, runs: run.executionRecovery?.state === 'unknown' ? [run] : [] });
      if (url.pathname === '/api/requests' && body.action === 'confirm_execution_stopped') {
        commands.push(body);
        run.executionRecovery = { schemaVersion: 1, revision: 3, state: 'operator_confirmed_stopped', reason: 'process_stop_unconfirmed', detectedAt: fixtureTime, confirmation: { operationId: body.operationId, note: body.note, observedAt: fixtureTime, confirmedAt: fixtureTime, basis: 'operator_attested' } };
        if (commands.length === 1) return Response.json({ error: 'Illustrative lost acknowledgement; the stop receipt was retained.' }, { status: 503 });
        return Response.json({ schemaVersion: 1, run, duplicate: true });
      }
      return previous(input, init);
    };
    return () => h('main', { style: 'padding:24px;max-width:900px;margin:auto;min-width:0' }, [h('p', 'Illustrative recovery · no process is inspected or stopped in this browser fixture.'), h(ExecutionRecoveryPanel)]);
  } }),
  play: async ({ canvasElement }) => {
    const q = within(canvasElement);
    await userEvent.click(await q.findByRole('button', { name: 'Inspect recovery for Ready Check: Stable ordering' }));
    const confirm = q.getByRole('button', { name: 'Record operator-confirmed stop' }) as HTMLButtonElement;
    if (!confirm.disabled) throw Error('Process inspection acknowledgement was not required.');
    await userEvent.click(q.getByRole('checkbox')); if (!confirm.disabled) throw Error('A nonempty inspection note was not required.');
    await userEvent.type(q.getByLabelText('Inspection and stop notes'), 'Inspected the provider process tree and stopped its remaining processes.');
    await userEvent.click(confirm); await q.findByText('Illustrative lost acknowledgement; the stop receipt was retained.');
    await userEvent.click(q.getByRole('button', { name: 'Retry same stop confirmation' }));
    await q.findByText('The operator-attested stop is recorded.', { exact: false });
    if (commands.length !== 2 || JSON.stringify(commands[0]) !== JSON.stringify(commands[1]) || commands[0].runId !== '11111111-1111-4111-8111-111111111111' || commands[0].expectedRevision !== 2 || !commands[0].operationId) throw Error('Recovery replay did not retain the exact inspected operation.');
    if (q.queryByRole('button', { name: /Resume|Retry Ready Check/ })) throw Error('Process confirmation implicitly offered continuation.');
    canvasElement.setAttribute('data-execution-recovery-ready', 'true');
  },
};
