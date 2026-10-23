import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { h, KeepAlive, nextTick } from 'vue';
import UApp from '@nuxt/ui/components/App.vue';
import TaskboardPage from '../src/worker/webview/pages/TaskboardPage.vue';
import type { SharedFeatureView } from '../src/worker/application/shared-intake-contract';
import { workerCapacitySnapshot } from '../src/worker/application/worker-capacity';
import { state } from '../src/worker/webview/store';
import { installWorkerFixture } from './worker-fixtures';

const meta = { title: 'Worker/Readiness review', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
const at = '2026-10-18T12:00:00.000Z';
function request(id: string, title: string, status: 'queued' | 'running' | 'waiting_input'): SharedFeatureView {
  return {
    id, title, name: `feature-requests/${id}.md`, status: status === 'waiting_input' ? 'waiting_ready_input' : 'reviewing_ready',
    owner: 'example-worker', isLocal: true, sourceCommit: 'a'.repeat(40), updatedAt: at,
    ready: null, done: null, featureBranch: null, reviewNote: null, publication: 'synced', error: null, taskId: null,
    readyReview: { status, attempt: 1, promptPath: 'docs/worker/ready-review.md', promptDigest: 'b'.repeat(64),
      sessionId: `review-${id}`, runId: `run-${id}`, findings: status === 'waiting_input' ? [{ kind: 'question', message: 'Which teams may export this data?', blocking: true }] : [] },
  };
}

export const TaskboardReadyChecks: Story = {
  name: 'Inspect Ready Checks on Taskboard',
  parameters: { storymap: { app: 'Worker', summary: 'Opt-in readiness reviews share the worker execution slot. Queued checks and Markdown answers stay visible before implementation is admitted, without creating extra conversations.',
    covers: ['src/worker/webview/pages/TaskboardPage.vue', 'src/worker/webview/components/OverviewTaskCard.vue'], route: '/taskboard', ready: '[data-ready-review-board]' } },
  render: () => ({ setup() {
    const base = installWorkerFixture('empty');
    const records = [request('search', 'Review search requirements', 'running'), request('exports', 'Clarify export permissions', 'waiting_input'), request('onboarding', 'Review team onboarding', 'queued')];
    state.environment!.sharedIntake = { dependencyPlans: [], selectedProjectId: 'demo', projects: [{id:'demo',label:'Demo project',enabled:true}], revision: 1, workerId: 'example-worker', config: { enabled: true, repositoryId: 'shared', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 5000 },
      canEdit: false, blockedReason: 'Pause and drain before changing shared intake.', state: 'idle', error: null, lastSyncedAt: at, sourceCommit: 'a'.repeat(40), workflow: null, requests: records };
    state.sessions!.execution = { currentSessionId: 'review-search', queued: 1, maxParallel: 1 };
    state.sessions!.capacity = workerCapacitySnapshot({ capturedAt: at, currentSessionId: 'review-search', localUsed: 2,
      settings: state.settings!.board, remote: { waiting: 0, running: 0 }, consumption: { blocked: false, reason: 'disabled' } });
    state.sessionsReadAt = at;
    const fetchFixture: typeof fetch = async (input, init) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin).pathname;
      if (path === '/api/runs') return Response.json({ schemaVersion: 1, total: 1, rows: [{ id: 'run-search', sessionId: 'review-search', taskId: 'review-search', sequence: 1, purpose: 'gate_review',
        title: 'Review search requirements', provider: 'codex-cli', model: 'gpt-example-review', outcome: 'running', acceptedAt: at, startedAt: at, after: null, usage: { inputTokens: 300, outputTokens: 80 } }], nextOffset: null, nextCursor: null, asOf: 1, scope: 'worker_session_executions' });
      return base.fetchFixture(input, init);
    };
    (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = fetchFixture;
    return () => h(UApp, null, { default: () => h('div', [h('p', { style: 'padding:16px;color:var(--ui-text-muted)' }, 'Illustrative data · no model connected or review performed'), h(KeepAlive, null, { default: () => h(TaskboardPage) })]) });
  } }),
  play: async ({ canvasElement }) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (canvasElement.textContent?.includes('Feature Request Ready Check')) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const text = canvasElement.textContent ?? '';
    for (const expected of ['Feature Request Ready Check', 'gpt-example-review', '380 tokens reported', 'Ready Check answers needed', 'Ready Check queued', 'commit and push']) {
      if (!text.includes(expected)) throw Error('Missing Taskboard readiness evidence: ' + expected);
    }
    if (text.includes('Open task controls') || text.includes('Stop task')) throw Error('A readiness reviewer must not expose implementation conversation controls.');
    await nextTick(); canvasElement.setAttribute('data-ready-review-board', 'true');
  },
};
