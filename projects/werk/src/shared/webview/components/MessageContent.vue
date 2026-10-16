<script setup lang="ts">
import { computed, h, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import { markdownNodes, markdownTokens } from '../markdown';
const props = withDefaults(defineProps<{ text: string; markdown?: boolean }>(), { markdown: true });
const copied = ref(-1), copyError = ref('');
let revision = 0;
watch(() => [props.text, props.markdown], () => { revision++; copied.value = -1; copyError.value = ''; }, { flush: 'sync' });
const tokens = computed(() => props.markdown ? markdownTokens(props.text) : []);
async function copy(text: string, index: number) {
  const current = revision;
  try { await navigator.clipboard.writeText(text); if (current === revision) { copied.value = index; copyError.value = ''; } }
  catch { if (current === revision) copyError.value = 'Copy is unavailable in this browser. Select the code to copy it.'; }
}
const Content = () => markdownNodes(tokens.value, (text, language, index) => h('div', { class: 'code-block', key: index }, [
  h('div', { class: 'code-toolbar' }, [h('span', language || 'Code'), h(UButton, { type: 'button', color: 'neutral', variant: 'ghost', size: 'sm', icon: copied.value === index ? 'i-lucide-check' : 'i-lucide-copy', onClick: () => copy(text, index) }, { default: () => copied.value === index ? 'Copied' : 'Copy code' })]),
  h('pre', { tabindex: 0, role: 'region', 'aria-label': language ? `Code block · ${language}` : 'Code block' }, h('code', text)),
]));
</script>
<template>
  <div class="message-content" :class="markdown ? 'markdown' : 'plain'">
    <Content v-if="markdown" />
    <p v-else>{{ text }}</p>
    <p v-if="copyError" role="status" class="page-note">{{ copyError }}</p>
  </div>
</template>
<style scoped>
.message-content { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.plain > p { white-space: pre-wrap; margin: 0; }
.markdown :deep(p) { white-space: normal; line-height: 1.7; margin: 0 0 12px; max-width: 72ch; }
.markdown :deep(h3), .markdown :deep(h4), .markdown :deep(h5), .markdown :deep(h6) { color: var(--ui-text-highlighted); font-weight: 650; line-height: 1.4; margin: 20px 0 10px; max-width: 72ch; }
.markdown :deep(h3) { font-size: 1.18em; } .markdown :deep(h4) { font-size: 1.08em; } .markdown :deep(h5), .markdown :deep(h6) { font-size: 1em; }
.markdown :deep(ul), .markdown :deep(ol) { margin: 10px 0 14px; padding-left: 24px; max-width: 72ch; }
.markdown :deep(ul) { list-style: disc; } .markdown :deep(ol) { list-style: decimal; }
.markdown :deep(li) { margin: 6px 0; padding-left: 2px; }
.markdown :deep(li > ul), .markdown :deep(li > ol) { margin-block: 6px; }
.markdown :deep(li > p) { margin-block: 6px; }
.markdown :deep(blockquote) { margin: 14px 0; border-left: 3px solid var(--ui-border-accented); padding: 4px 0 4px 14px; color: var(--ui-text-muted); max-width: 72ch; }
.markdown :deep(blockquote > :last-child) { margin-bottom: 0; }
.markdown :deep(a) { color: var(--ui-primary); text-decoration: underline; text-underline-offset: 3px; overflow-wrap: anywhere; }
.markdown :deep(code) { font-family: var(--font-mono, ui-monospace, monospace); font-size: .92em; background: #233540; padding: 2px 4px; border-radius: 4px; overflow-wrap: anywhere; }
.markdown :deep(pre) { max-width: 100%; overflow: auto; white-space: pre; overflow-wrap: normal; tab-size: 2; }
.markdown :deep(pre code) { display: block; min-width: max-content; background: transparent; padding: 0; border-radius: 0; white-space: pre; overflow-wrap: normal; }
.markdown :deep(.code-block) { min-width: 0; max-width: 100%; margin: 16px 0; border: 1px solid var(--ui-border); border-radius: 8px; overflow: hidden; }
.markdown :deep(.code-toolbar) { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 4px 12px; background: #17232c; font-size: .75rem; color: var(--ui-text-muted); flex-wrap: wrap; }
.markdown :deep(.code-block pre) { margin: 0; border-radius: 0; padding: 16px; }
.markdown :deep(.markdown-table-scroll) { max-width: 100%; overflow-x: auto; margin: 16px 0; border: 1px solid var(--ui-border); border-radius: 7px; }
.markdown :deep(table) { width: 100%; border-collapse: collapse; font-size: .92em; }
.markdown :deep(th), .markdown :deep(td) { min-width: 100px; padding: 9px 12px; border-bottom: 1px solid var(--ui-border); text-align: left; vertical-align: top; overflow-wrap: normal; }
.markdown :deep(th) { color: var(--ui-text-highlighted); font-weight: 650; background: var(--ui-bg-elevated); }
.markdown :deep(tr:last-child td) { border-bottom: 0; }
.markdown :deep(hr) { margin: 18px 0; border: 0; border-top: 1px solid var(--ui-border); }
.markdown :deep(.markdown-literal) { white-space: pre-wrap; }
.markdown :deep(.markdown-task-item) { list-style: none; }
.markdown :deep(.markdown-task-marker) { display: inline-block; width: 20px; margin-left: -22px; margin-right: 2px; color: var(--ui-primary); }
.markdown :deep(> :first-child) { margin-top: 0; } .markdown :deep(> :last-child) { margin-bottom: 0; }
</style>
