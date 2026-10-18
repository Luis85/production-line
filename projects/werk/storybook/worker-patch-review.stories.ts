import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { h, nextTick } from 'vue';
import UApp from '@nuxt/ui/components/App.vue';
import PatchReview from '../src/worker/webview/components/PatchReview.vue';
const meta = { title: 'Worker/Review changes', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
const storymap = { app: 'Worker', summary: 'Inspect saved changes by file, compare line positions and download the complete unchanged patch. This view never applies or approves changes.', covers: ['src/worker/webview/components/PatchReview.vue'], route: '/review', ready: '[data-patch-review-ready]' };
const first = 'diff --git a/src/requests.ts b/src/requests.ts\n--- a/src/requests.ts\n+++ b/src/requests.ts\n@@ -1,2 +1,3 @@\n export function label() {\n-  return "Request";\n+  const title = "Feature request";\n+  return title;\n';
const second = 'diff --git a/docs/team workflow.md b/docs/team workflow.md\n--- a/docs/team workflow.md\n+++ b/docs/team workflow.md\n@@ -1 +1 @@\n-Review the output.\n+Review the saved patch and required checks.\n';
function render(patch: string) { return () => ({ setup: () => () => h(UApp, null, { default: () => h('main', { style: 'max-width:1100px;margin:auto;padding:24px;min-width:0' }, [h('h1', { style: 'font-size:24px;margin-bottom:16px' }, 'Review saved changes'), h('p', { class: 'page-note' }, 'Illustrative patch · no model call, file edit or merge was performed'), h(PatchReview, { patch, taskId: 'example-feature' })]) }) }); }
async function ready(canvas: HTMLElement) { await nextTick(); canvas.setAttribute('data-patch-review-ready', 'true'); }
export const MultipleFiles: Story = {
  name: 'Compare changed files', parameters: { storymap }, render: render(first + second),
  play: async ({ canvasElement }) => {
    await nextTick(); const files = canvasElement.querySelectorAll<HTMLButtonElement>('.patch-files button');
    if (files.length !== 2 || !canvasElement.querySelector('.diff-added') || !canvasElement.querySelector('.diff-removed')) throw Error('Readable changes are missing.');
    files[1].click(); await nextTick();
    const heading = canvasElement.querySelector<HTMLElement>('.patch-content h3');
    if (heading?.textContent !== 'docs/team workflow.md' || document.activeElement !== heading) throw Error('File navigation must preserve the filename and move keyboard focus to its changes.');
    if (!canvasElement.querySelector('.patch-lines[tabindex="0"][role="region"]')) throw Error('Patch scrolling must be keyboard accessible.');
    await ready(canvasElement);
  },
};
export const UntrustedText: Story = {
  name: 'Unusual paths and inert patch content', parameters: { storymap },
  render: render('diff --git "a/docs/long project name/checks and review.md" "b/docs/long project name/checks and review.md"\n--- "a/docs/long project name/checks and review.md"\n+++ "b/docs/long project name/checks and review.md"\n@@ -1 +1 @@\n-safe text\n+<img src=x onerror="alert(1)"> & <script>unsafe()</script>\n'),
  play: async ({ canvasElement }) => {
    await nextTick();
    if (canvasElement.querySelector('.patch-review img, .patch-review script') || !canvasElement.textContent?.includes('<img src=x')) throw Error('Patch content must be inert text.');
    await ready(canvasElement);
  },
};
export const LargePatch: Story = {
  name: 'Bounded preview preserves the full download', parameters: { storymap },
  render: render('diff --git a/large.txt b/large.txt\n--- /dev/null\n+++ b/large.txt\n@@ -0,0 +1,5000 @@\n' + '+A retained source line with an explicit change marker.\n'.repeat(5000)),
  play: async ({ canvasElement }) => {
    await nextTick();
    if (!canvasElement.textContent?.includes('Counts describe the parsed preview') || canvasElement.querySelectorAll('.patch-lines tbody tr').length > 2000) throw Error('Large patch preview must remain bounded and explain its counts.');
    if (![...canvasElement.querySelectorAll('button')].some(button => button.textContent?.includes('Download full patch'))) throw Error('Full patch download is missing.');
    await ready(canvasElement);
  },
};
export const MalformedPatch: Story = {
  name: 'Incomplete hunks retain inspectable text', parameters: { storymap }, render: render('diff --git a/feature.ts b/feature.ts\n--- a/feature.ts\n+++ b/feature.ts\n@@ -1,8 +1,3 @@\n-previous\n+next\n'),
  play: async ({ canvasElement }) => { await nextTick(); if (!canvasElement.textContent?.includes('Some lines could not be interpreted')) throw Error('Incomplete patch must not look fully parsed.'); await ready(canvasElement); },
};
