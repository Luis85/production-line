<script setup lang="ts">
import { computed } from 'vue';
import UIcon from '@nuxt/ui/components/Icon.vue';
import MessageContent from './MessageContent.vue';
import { readableReply, type ReplyContext } from '../../application/readable-reply';
// Completed model replies. Saved protocol JSON (older file-task transcripts and checkpoints) is shown readably;
// its stored text stays available, collapsed, as evidence.
const props = defineProps<{ text: string; patchTaskId?: string; fileTask?: ReplyContext['fileTask'] }>();
const reply = computed(() => readableReply(props.text, { fileTask: props.fileTask }));
</script>
<template>
  <div class="assistant-message">
    <MessageContent :text="reply.text" />
    <RouterLink v-if="patchTaskId" class="patch-review-link" :to="{ path: '/history', query: { fileId: patchTaskId } }">Review saved patch<UIcon name="i-lucide-arrow-up-right" /></RouterLink>
    <details v-if="reply.raw" class="raw-output">
      <summary>Raw model output</summary>
      <p class="page-note">Stored reply text; older entries may be shortened. Inspect the current retained patch in its review view.</p>
      <pre tabindex="0" role="region" aria-label="Raw model output">{{ reply.raw }}</pre>
    </details>
  </div>
</template>
<style scoped>
.assistant-message { min-width: 0; }
.patch-review-link { display: inline-flex; align-items: center; gap: 7px; min-height: 44px; margin-top: 4px; color: var(--ui-primary); font-weight: 550; text-decoration: underline; text-underline-offset: 3px; }
.raw-output { margin-top: 8px; font-size: .75rem; }
.raw-output > summary { cursor: pointer; color: var(--ui-text-muted); padding-block: 12px; min-height: 44px; }
.raw-output pre { max-height: 240px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: .75rem; }
</style>
