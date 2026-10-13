<script setup lang="ts">
import { computed, ref } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
const props = defineProps<{ text: string }>();
const copied = ref(-1), copyError = ref('');
// Render model output as Vue text nodes; imported or generated HTML is never interpreted.
const blocks = computed(() => {
  const parts: { kind: 'text' | 'code'; text: string; language?: string }[] = [];
  const pattern = /```([^\n]*)\n([\s\S]*?)(?:```|$)/g; let previous = 0;
  for (const match of props.text.matchAll(pattern)) {
    if (match.index! > previous) parts.push({ kind: 'text', text: props.text.slice(previous, match.index) });
    parts.push({ kind: 'code', language: match[1]?.trim(), text: match[2] ?? '' }); previous = match.index! + match[0].length;
  }
  if (previous < props.text.length) parts.push({ kind: 'text', text: props.text.slice(previous) });
  return parts;
});
function inline(text: string) { return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map(value => ({ kind: value.startsWith('`') && value.endsWith('`') ? 'code' : value.startsWith('**') && value.endsWith('**') ? 'strong' : 'text', text: value.startsWith('`') && value.endsWith('`') ? value.slice(1, -1) : value.startsWith('**') && value.endsWith('**') ? value.slice(2, -2) : value })); }
async function copy(text: string, index: number) { try { await navigator.clipboard.writeText(text); copied.value = index; copyError.value = ''; } catch { copyError.value = 'Copy is unavailable in this browser. Select the code to copy it.'; } }
</script>
<template><div class="message-content"><template v-for="(block, index) in blocks" :key="index"><div v-if="block.kind === 'code'" class="code-block"><div class="code-toolbar"><span>{{ block.language || 'Code' }}</span><UButton color="neutral" variant="ghost" size="sm" :icon="copied === index ? 'i-lucide-check' : 'i-lucide-copy'" @click="copy(block.text, index)">{{ copied === index ? 'Copied' : 'Copy code' }}</UButton></div><pre><code>{{ block.text }}</code></pre></div><template v-else><template v-for="(paragraph, pi) in block.text.trim().split(/\n\s*\n/)" :key="pi"><ul v-if="paragraph.split('\n').every(line => /^\s*[-*] /.test(line))"><li v-for="(line, li) in paragraph.split('\n')" :key="li"><template v-for="(part, j) in inline(line.replace(/^\s*[-*] /, ''))" :key="j"><code v-if="part.kind === 'code'">{{ part.text }}</code><strong v-else-if="part.kind === 'strong'">{{ part.text }}</strong><template v-else>{{ part.text }}</template></template></li></ul><p v-else><template v-for="(part, j) in inline(paragraph)" :key="j"><code v-if="part.kind === 'code'">{{ part.text }}</code><strong v-else-if="part.kind === 'strong'">{{ part.text }}</strong><template v-else>{{ part.text }}</template></template></p></template></template></template><p v-if="copyError" role="status" class="page-note">{{ copyError }}</p></div></template>
