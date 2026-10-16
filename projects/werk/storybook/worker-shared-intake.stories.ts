import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { h, nextTick } from 'vue';
import UApp from '@nuxt/ui/components/App.vue';
import SharedIntakePanel from '../src/worker/webview/components/SharedIntakePanel.vue';
import type { SharedIntakeView } from '../src/worker/application/shared-intake-contract';
import { state } from '../src/worker/webview/store';
import { installWorkerFixture, fixtureTime } from './worker-fixtures';
const meta = { title: 'Worker/Shared request intake', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
const fixture = (configured: boolean, blocked: boolean): SharedIntakeView => ({
  revision: configured ? 3 : 0, workerId: 'desktop-worker', config: { enabled: configured, repositoryId: configured ? 'project' : '', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 5000 }, canEdit: !blocked, blockedReason: blocked ? 'Pause new starts and finish or stop queued and running work before changing shared intake.' : null,
  state: configured ? 'idle' : 'disabled', error: null, lastSyncedAt: configured ? fixtureTime : null, sourceCommit: configured ? 'abc1234-fixture-source' : null,
  workflow: configured ? { requestsDirectory: 'features/requests', reviewDirectory: 'features/reviews', template: 'features/Feature request.template.md', base: 'features/Feature requests.base', readyCheck: 'features/checks/ready.json', doneCheck: 'features/checks/done.json', readyDigest: 'ready-check-fixture-digest', doneDigest: 'done-check-fixture-digest' } : null,
  requests: configured ? [
    { id: 'request-docs', name: 'clarify-worker-setup.md', title: 'Clarify the worker setup guide', status: 'review', owner: 'desktop-worker', isLocal: true, sourceCommit: 'abc1234-fixture-source', updatedAt: fixtureTime, ready: { passed: true, issues: [] }, done: { passed: false, issues: ['Human acceptance has not been recorded.', 'Build evidence is not available for this revision.'] }, featureBranch: 'werk/request-docs', reviewNote: 'features/reviews/request-docs.md', publication: 'error', error: 'Remote updates changed while publishing. Local progress is retained; synchronize to inspect the latest shared state.', taskId: 'shared-feature-docs' },
    { id: 'request-tests', name: 'cover-worker-restart.md', title: 'Cover worker restart behavior', status: 'running', owner: 'team-worker', isLocal: false, sourceCommit: 'abc1234-fixture-source', updatedAt: fixtureTime, ready: { passed: true, issues: [] }, done: null, featureBranch: 'werk/request-tests', reviewNote: 'features/reviews/request-tests.md', publication: 'synced', error: null, taskId: null },
    { id: 'request-draft', name: 'clarify-release-goal.md', title: 'Clarify the release goal', status: 'needs_rework', owner: null, isLocal: false, sourceCommit: 'abc1234-fixture-source', updatedAt: fixtureTime, ready: { passed: false, issues: ['Add acceptance criteria before requesting execution.'] }, done: null, featureBranch: null, reviewNote: null, publication: 'synced', error: null, taskId: null },
  ] : [],
});
function render(configured = false, blocked = false) {
  return () => ({ setup() {
    const installed = installWorkerFixture('empty'), view = fixture(configured, blocked);
    state.settings!.repositories.items = [{ id: 'project', path: '/example/projects/shared-product', remote: 'origin', branch: 'main', watch: true }];
    state.settings!.board.paused = !blocked;
    const fetchFixture: typeof fetch = (input, init = {}) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
      if (path === '/api/shared-intake') {
        const command = typeof init.body === 'string' ? JSON.parse(init.body) : {};
        if (command.action === 'note') return Promise.resolve(Response.json({ path: 'features/reviews/' + command.id + '.md', markdown: '# Shared review note\n\n**Illustrative fixture.** No model call, build or Git publication was performed.\n\n## Remaining checks\n\n- Record human acceptance.\n- Attach build evidence for the proposed revision.\n\n| Check | Observation |\n| --- | --- |\n| Ready | Recorded as passed |\n| Done | Human acceptance pending |\n\n[Review guidance](https://example.com/review).' }));
        if (init.method === 'POST') return Promise.resolve(Response.json({ error: 'Illustrative fixture. Runtime and Git changes are disabled.' }, { status: 409 }));
        return Promise.resolve(Response.json(view));
      }
      return installed.fetchFixture(input, init);
    };
    (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = fetchFixture;
    return () => h(UApp, null, { default: () => h('div', { style: 'max-width:1050px;margin:auto;padding:24px;min-width:0' }, [h('p', { class: 'page-note' }, 'Illustrative shared requests · no model or Git remote is contacted'), h(SharedIntakePanel)]) });
  } });
}
async function element(canvas: HTMLElement, selector: string) { for (let n = 0; n < 100; n++) { const item = canvas.querySelector<HTMLElement>(selector); if (item) return item; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error('Shared intake story did not render ' + selector); }
async function ready(canvas: HTMLElement) { await nextTick(); canvas.setAttribute('data-shared-intake-ready', 'true'); }
const storymap = (summary: string, note = false) => ({ app: 'Worker', summary, covers: ['src/worker/webview/components/SharedIntakePanel.vue', ...(note ? ['src/worker/webview/components/MessageContent.vue'] : [])], route: '/dashboard#shared-intake', ready: '[data-shared-intake-ready]' });
export const ConnectRepository: Story = { name: 'Connect a shared repository', parameters: { storymap: storymap('Shared intake and automatic publication require an explicit local repository binding; checked-in workflow files remain authoritative.') }, render: render(), play: async ({ canvasElement }) => { const checkbox = await element(canvasElement, '.shared-intake-check input') as HTMLInputElement; if (checkbox.checked) throw Error('Shared intake must be disabled by default.'); await element(canvasElement, '#shared-intake-workflow'); await ready(canvasElement); } };
export const ReviewChecks: Story = { name: 'Inspect checks and published review notes', parameters: { storymap: storymap('Ready and done findings, local ownership, feature branch and Git publication failure remain distinct; review notes render safely.', true) }, render: render(true), play: async ({ canvasElement }) => {
  (await element(canvasElement, '[aria-label="Inspect shared request Clarify the worker setup guide"]')).click();
  await element(canvasElement, '#shared-request-detail-title');
  if (!canvasElement.querySelector('.shared-gate-results')?.textContent?.includes('Human acceptance has not been recorded.')) throw Error('Done check failure is missing.');
  const button = [...canvasElement.querySelectorAll<HTMLButtonElement>('.shared-request-detail button')].find(item => item.textContent?.includes('Read review note')); if (!button) throw Error('Review note control missing.'); button.click();
  await element(canvasElement, '.shared-review-note .markdown h3'); await element(canvasElement, '.shared-review-note table');
  await ready(canvasElement);
} };
export const OtherWorker: Story = { name: 'Observe another worker’s request', parameters: { storymap: storymap('Another worker’s ownership is explicit and the local worker offers inspection without task execution controls.') }, render: render(true), play: async ({ canvasElement }) => {
  (await element(canvasElement, '[aria-label="Inspect shared request Cover worker restart behavior"]')).click(); await element(canvasElement, '#shared-request-detail-title');
  const detail = canvasElement.querySelector('.shared-request-detail'); if (!detail?.textContent?.includes('Another worker owns this request.')) throw Error('Foreign ownership guidance missing.'); if (detail.querySelector('a[href="/taskboard"]')) throw Error('Foreign request must not offer local task navigation.'); await ready(canvasElement);
} };
export const DrainBeforeChanging: Story = { name: 'Pause and drain before changing intake', parameters: { storymap: storymap('Operators may draft a connection while work runs, with clear pause and drain guidance before saving.') }, render: render(false, true), play: async ({ canvasElement }) => { await element(canvasElement, '#shared-intake-workflow'); if (!canvasElement.textContent?.includes('Pause new starts and finish or stop queued and running work')) throw Error('Drain guidance missing.'); await ready(canvasElement); } };
