import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { h, nextTick } from 'vue';
import UApp from '@nuxt/ui/components/App.vue';
import { userEvent } from 'storybook/test';
import WorkerShell from '../src/worker/webview/components/WorkerShell.vue';
import ReviewPage from '../src/worker/webview/pages/ReviewPage.vue';
import { state } from '../src/worker/webview/store';
import { router } from './router';
import { installReviewFixture, type ReviewFixture } from './worker-review-fixtures';
const meta = { title: 'Worker/Review', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
let fixture: ReturnType<typeof installReviewFixture>;
const storymap = (summary: string) => ({ app: 'Worker', summary, covers: ['pages/ReviewPage', 'components/PatchReview', 'components/CandidateEvidence', 'components/RequestGatePanel'].map(name => 'src/worker/webview/' + name + '.vue'), route: '/review?session=file&fileId=file-review', ready: '[data-review-ready]' });
function render(variant: ReviewFixture = 'verified') {
  return () => ({ setup() {
    fixture = installReviewFixture(variant);
    return () => h(UApp, null, { default: () => h(WorkerShell, { links: [{ path: '/taskboard', label: 'Taskboard', icon: 'i-lucide-columns-2' }, { path: '/dashboard', label: 'Metrics', icon: 'i-lucide-activity' }, { path: '/history', label: 'History', icon: 'i-lucide-history' }, { path: '/settings', label: 'Settings', icon: 'i-lucide-settings-2' }], homePath: '/taskboard', homeLabel: 'Werk worker home', navLabel: 'Worker pages' }, {
      identity: () => h('div', { class: 'worker-identity' }, [h('div', [h('strong', 'Example worker'), h('span', 'Fictional review data')])]),
      default: () => h(ReviewPage), footer: () => 'Illustrative review · no model call, command or Git write occurred',
    }) });
  } });
}
async function element<T extends HTMLElement = HTMLElement>(canvas: HTMLElement, selector: string): Promise<T> {
  for (let n = 0; n < 150; n++) { const result = canvas.querySelector<T>(selector); if (result) return result; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error('Review story missing ' + selector);
}
async function ready(canvas: HTMLElement) { await nextTick(); if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) throw Error('Review page overflows its viewport'); canvas.setAttribute('data-review-ready', 'true'); }
async function loaded(canvas: HTMLElement) {
  await element(canvas, '#review-decision .request-gate-panel');
  if (state.sessions?.selected !== 'completed' || fixture.mutations.length) throw Error('Reading a review changed selected conversation or mutated work');
}
export const VerifiedCandidate: Story = { name: 'Review changes and record acceptance', parameters: { storymap: storymap('One canonical feature request links accepted scope, the patch, checks and human acceptance. Passing checks never implies a merge.') }, render: render(), play: async ({ canvasElement }) => {
  await loaded(canvasElement); await element(canvasElement, '#request-attestation-note');
  const primary = await element<HTMLAnchorElement>(canvasElement, '.review-next a');
  if (!primary.textContent?.includes('acceptance') || !primary.href.endsWith('#review-decision')) throw Error('The next decision must lead to acceptance');
  const goal = await element(canvasElement, '#review-goal'); if (!goal.textContent?.includes('Acceptance criteria')) throw Error('Accepted criteria missing');
  await userEvent.click(primary); await nextTick();
  if (router.currentRoute.value.query.session !== 'file' || router.currentRoute.value.query.fileId !== 'file-review' || !canvasElement.querySelector('#request-attestation-note')) throw Error('The primary review anchor lost the canonical request identity');
  await ready(canvasElement);
} };
export const RecordAcceptance: Story = { name: 'Acceptance updates the request, never merges the patch', parameters: { storymap: storymap('The matching acceptance command records the note, reevaluates completion and preserves separate patch review.') }, render: render(), play: async ({ canvasElement }) => {
  await loaded(canvasElement); const input = await element<HTMLTextAreaElement>(canvasElement, '#request-attestation-note');
  input.value = 'Reviewed the accepted criteria, patch and required checks.'; input.dispatchEvent(new Event('input', { bubbles: true })); await nextTick();
  const button = await element<HTMLButtonElement>(canvasElement, '#request-attestation button[type="submit"]'); button.click();
  await element(canvasElement, '.request-attestation-recorded');
  if (fixture.mutations.length !== 1 || fixture.mutations[0]!.action !== 'attest' || fixture.request.phase !== 'done') throw Error('Acceptance must use one guarded request command');
  if (!canvasElement.textContent?.includes('before applying or merging')) throw Error('Human patch review must remain separate');
  await ready(canvasElement);
} };
export const FailedChecks: Story = { name: 'Failed verification has a clear repair step', parameters: { storymap: storymap('Failed required checks lead to evidence, without treating acceptance as proof that tests passed.') }, render: render('failed'), play: async ({ canvasElement }) => {
  await loaded(canvasElement); const next = await element(canvasElement, '.review-next'); if (!next.textContent?.includes('verification')) throw Error('Verification failure must be the next step'); await ready(canvasElement);
} };
export const OutdatedChecks: Story = { name: 'Outdated checks cannot verify a new candidate', parameters: { storymap: storymap('The recorded candidate digest differs from the check receipts. The page points to the checks that need rerunning.') }, render: render('stale'), play: async ({ canvasElement }) => { await loaded(canvasElement); await element(canvasElement, '.candidate-evidence'); if (!canvasElement.textContent?.includes('Needs rerun')) throw Error('Outdated evidence must stay visible'); await ready(canvasElement); } };
export const PublishingHandoff: Story = { name: 'Completed locally, publication still pending', parameters: { storymap: storymap('Successful local work is distinct from confirmation that the team can see its notes and branch.') }, render: render('publishing'), play: async ({ canvasElement }) => { await loaded(canvasElement); const handoff = await element(canvasElement, '#review-handoff'); if (!handoff.textContent?.includes('Waiting to publish')) throw Error('Pending publication must not claim a shared handoff'); await ready(canvasElement); } };
export const PublishedHandoff: Story = { name: 'Published branch and review note await the team', parameters: { storymap: storymap('The team can find the published PullRequest note and feature branch. A human reviews and merges changes through Git.') }, render: render('published'), play: async ({ canvasElement }) => { await loaded(canvasElement); const handoff = await element(canvasElement, '#review-handoff'); if (!handoff.textContent?.includes('reviews/FR-42-review.md') || !handoff.textContent.includes('Published to shared Git')) throw Error('Published handoff must expose the exact review note'); await ready(canvasElement); } };
export const AnswerNeeded: Story = { name: 'Answer the existing checkpoint', parameters: { storymap: storymap('A question sends the operator to the existing conversation and retained checkpoint without creating another workflow.') }, render: render('question'), play: async ({ canvasElement }) => {
  await loaded(canvasElement); const next = await element<HTMLAnchorElement>(canvasElement, '.review-next a'); if (!next.getAttribute('href')?.includes('/taskboard?session=file')) throw Error('Answer must target the same conversation'); await ready(canvasElement);
} };
export const InterruptedAttempt: Story = { name: 'Inspect an interrupted attempt before resuming', parameters: { storymap: storymap('Uncertain execution retains its explicit continuation path. Opening review does not replay model work.') }, render: render('interrupted'), play: async ({ canvasElement }) => { await loaded(canvasElement); const next = await element<HTMLAnchorElement>(canvasElement, '.review-next a'); if (!next.getAttribute('href')?.includes('/taskboard?session=file')) throw Error('Resume must use the existing checkpoint'); await ready(canvasElement); } };
export const UnavailableRequest: Story = { name: 'A missing request never shows another task', parameters: { storymap: { ...storymap('Unavailable identity displays an actionable read error and never falls back to the selected conversation.'), covers: ['src/worker/webview/pages/ReviewPage.vue'] } }, render: render('missing'), play: async ({ canvasElement }) => { await element(canvasElement, '[role="alert"]'); if (canvasElement.querySelector('#review-decision') || state.sessions?.selected !== 'completed') throw Error('Missing review must not expose unrelated decisions'); await ready(canvasElement); } };
export const QuietRefresh: Story = { name: 'Background refresh preserves the acceptance draft and focus', parameters: { storymap: storymap('Routine polling keeps controls, typed acceptance text and keyboard focus stable.') }, render: render(), play: async ({ canvasElement }) => {
  await loaded(canvasElement); const input = await element<HTMLTextAreaElement>(canvasElement, '#request-attestation-note'); input.focus(); input.value = 'Checking the ordering edge cases.'; input.dispatchEvent(new Event('input', { bubbles: true })); await nextTick();
  fixture.quietRefresh(); await new Promise(resolve => setTimeout(resolve, 80)); await nextTick();
  if (canvasElement.querySelector('#request-attestation-note') !== input || input.value !== 'Checking the ordering edge cases.' || document.activeElement !== input) throw Error('Quiet refresh replaced or reset the review draft');
  await ready(canvasElement);
} };
export const StaleReview: Story = { name: 'A failed refresh retains evidence and disables decisions', parameters: { storymap: storymap('The last matching request stays readable after a failed refresh, but acceptance cannot use stale combined evidence.') }, render: render(), play: async ({ canvasElement }) => {
  await loaded(canvasElement); await element(canvasElement, '#request-attestation-note'); fixture.failNextRead(); await element(canvasElement, '.review-notice[role="alert"]'); await nextTick();
  if (!(canvasElement.querySelector('#request-attestation-note') as HTMLTextAreaElement)?.disabled || !canvasElement.querySelector('#review-changes')) throw Error('Stale evidence must remain readable with decisions disabled'); await ready(canvasElement);
} };
export const KeyboardReview: Story = { name: 'Review anchors and patch navigation work by keyboard', parameters: { storymap: storymap('Section links and file navigation use native keyboard controls and retain visible labels at narrow widths.') }, render: render(), play: async ({ canvasElement }) => {
  await loaded(canvasElement); const changes = await element<HTMLAnchorElement>(canvasElement, '.review-sections a[href="#review-changes"]'); changes.focus(); await userEvent.keyboard('{Enter}');
  if (document.activeElement !== changes && !canvasElement.querySelector('#review-changes')?.contains(document.activeElement)) throw Error('Keyboard review navigation lost its target');
  const secondFile = await element<HTMLButtonElement>(canvasElement, '.patch-files button:nth-child(2)'); secondFile.focus(); await userEvent.keyboard('{Enter}'); await nextTick();
  const fileHeading = await element(canvasElement, '.patch-content h3'); if (!fileHeading.textContent?.includes('test/requests.test.ts') || document.activeElement !== fileHeading) throw Error('Keyboard file navigation must expose and focus the selected diff');
  const conversation = await element<HTMLAnchorElement>(canvasElement, '.review-header-actions a'); if (!conversation.getAttribute('href')?.includes('session=file')) throw Error('Conversation link lost request identity'); await ready(canvasElement);
} };

export const MismatchedEvidence: Story = { name: 'Conflicting evidence cannot replace a matching review', parameters: { storymap: storymap('A mismatched feature identity is rejected before adoption. The earlier matching snapshot stays visible with decisions disabled.') }, render: render(), play: async ({ canvasElement }) => {
  await loaded(canvasElement); await element(canvasElement, '#request-attestation-note'); const goal = canvasElement.querySelector('#review-goal')?.textContent; fixture.changeOwnership();
  const warning = await element(canvasElement, '.review-notice[role="alert"]'); await nextTick();
  if (!warning.textContent?.includes('identities do not agree') || canvasElement.querySelector('#review-goal')?.textContent !== goal || !(canvasElement.querySelector('#request-attestation-note') as HTMLTextAreaElement)?.disabled) throw Error('Conflicting evidence must not replace the matching scope or enable decisions'); await ready(canvasElement);
} };

export const RequestNavigation: Story = { name: 'Changing request identity clears the previous review', parameters: { storymap: storymap('Changing the route never carries a previous request’s evidence or decisions into another identity. Returning restores only that request’s own draft.') }, render: render(), play: async ({ canvasElement }) => {
  await loaded(canvasElement); const input = await element<HTMLTextAreaElement>(canvasElement, '#request-attestation-note');
  input.value = 'Review draft for the original request only.'; input.dispatchEvent(new Event('input', { bubbles: true })); await nextTick();
  await router.replace({ path: '/review', query: { session: 'different-session', fileId: 'different-task' } });
  await element(canvasElement, '.review-notice[role="alert"]');
  if (canvasElement.querySelector('#review-goal') || canvasElement.querySelector('#review-decision') || canvasElement.textContent?.includes(input.value)) throw Error('Changing request identity retained unrelated review evidence or decisions');
  await router.replace({ path: '/review', query: { session: 'file', fileId: 'file-review' } });
  const restored = await element<HTMLTextAreaElement>(canvasElement, '#request-attestation-note');
  if (restored.value !== input.value || state.sessions?.selected !== 'completed' || fixture.mutations.length) throw Error('Returning must restore only the original request draft without selecting or mutating a conversation');
  await ready(canvasElement);
} };
