<script setup lang="ts">
import { computed, onActivated, onDeactivated, onBeforeUnmount, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import MessageContent from './MessageContent.vue';
import type { SessionView } from '../../application/workspace-view';
import { createFeatureRequestNoteReader, splitFeatureRequestMarkdown } from '../feature-request-note';
import { date, refresh, request, state, taskStatus } from '../store';
const props = defineProps<{ session: SessionView['records'][number] }>();
const open = ref(false), active = ref(true);
const reader = createFeatureRequestNoteReader({ sessionId: () => props.session.id, revision: () => props.session.featureRequest?.revision, unlocked: () => state.unlocked && active.value, epoch: () => state.draftEpoch, read: sessionId => request('/api/feature-tracking', 'POST', { action: 'get', sessionId }) });
const { view } = reader;
const record = computed(() => props.session.featureRequest ?? view.note);
const content = computed(() => splitFeatureRequestMarkdown(view.note?.markdown ?? ''));
const source = computed(() => props.session.feature?.sourcePath);
const sourceBacked = computed(() => !!props.session.feature && props.session.feature.source !== 'interaction');
const trackingError = computed(() => state.sessions?.featureTracking?.error);
watch(open, value => { if (value && active.value) void reader.load(); });
watch(() => props.session.featureRequest?.revision, () => { if (open.value && active.value) void reader.load(true); });
onActivated(() => { active.value = true; if (open.value) void reader.load(true); });
onDeactivated(() => { active.value = false; });
onBeforeUnmount(reader.dispose);
async function refreshRecord() { await reader.load(); if (state.unlocked && active.value) await refresh(); }
async function download() {
  const id = props.session.id, epoch = state.draftEpoch, note = await reader.load();
  if (!note || !state.unlocked || !active.value || id !== props.session.id || epoch !== state.draftEpoch) return;
  const url = URL.createObjectURL(new Blob([note.markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = note.filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>
<template>
  <section id="feature-request-note" class="feature-request-note" :aria-label="sourceBacked ? 'Execution progress' : 'Feature request record'">
    <p v-if="session.feature" class="canonical-feature-source"><strong>Feature Request · {{ session.feature.id }}</strong><template v-if="source"><br>{{ source }}</template></p>
    <p v-if="record" class="feature-request-filename"><strong>{{ sourceBacked ? 'Progress note · ' : '' }}{{ record.filename }}</strong><span>Recorded status: {{ taskStatus(record.status).replaceAll('_', ' ') }} · {{ date(record.updatedAt) }}</span></p>
    <p v-else role="status" class="page-note">{{ trackingError ? 'The request is accepted; its execution progress note is not available yet.' : 'Saving execution progress…' }}</p>
    <p v-if="trackingError" class="error-text" role="status">Request tracking could not update every Markdown record. Latest progress may not be reflected. {{ trackingError }}</p>
    <details :open="open" @toggle="open = ($event.target as HTMLDetailsElement).open">
      <summary>{{ sourceBacked ? 'Execution progress' : 'Feature request Markdown' }}</summary>
      <p class="page-note">{{ sourceBacked ? 'This generated note shows execution evidence for the Feature Request above. It does not replace that source or accept replies.' : 'The worker maintains this record as the request progresses. Readiness, results and human review remain recorded separately.' }}</p>
      <p v-if="record" class="feature-request-path">{{ record.path }}</p>
      <div class="note-actions"><UButton type="button" color="neutral" variant="outline" :loading="view.loading" :disabled="!state.unlocked" @click="refreshRecord">{{ sourceBacked ? 'Refresh progress' : 'Refresh request record' }}</UButton><UButton type="button" color="neutral" variant="ghost" :disabled="!state.unlocked || view.loading" @click="download">Download Markdown</UButton></div>
      <p v-if="view.loading && !view.note" role="status">Reading execution progress…</p>
      <p v-if="view.error" class="error-text" role="alert">{{ view.error }} The accepted request is retained. Refresh the record to try again.</p>
      <p v-if="view.stale" class="page-note" role="status">This displayed note may be older than the current request. Refresh the record to check the latest progress.</p>
      <MessageContent v-if="view.note" :text="content.body" class="request-markdown" /><details v-if="view.note && content.metadata" class="note-metadata"><summary>Record metadata</summary><pre>{{ content.metadata }}</pre></details>
    </details>
  </section>
</template>
<style scoped>
.feature-request-note { min-width: 0; margin-block: var(--space-4); padding: var(--space-4); border: 1px solid var(--ui-border); border-radius: 8px; }
.feature-request-note p { margin: 0 0 var(--space-3); font-size: .8125rem; line-height: 1.6; overflow-wrap: anywhere; }
.feature-request-filename { display: grid; gap: var(--space-1); }
.feature-request-filename span, .feature-request-path { color: var(--ui-text-muted); font-size: .75rem; }
.feature-request-note summary { min-height: 44px; padding-block: var(--space-3); cursor: pointer; font-size: .8125rem; font-weight: 600; }
.note-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-block: var(--space-3); }
.note-actions :deep(button) { min-height: 44px; }
.note-metadata pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .75rem; }
.request-markdown { max-height: 480px; overflow: auto; overflow-wrap: anywhere; font-size: .875rem; }
@media (max-width: 480px) { .note-actions { display: grid; } .note-actions :deep(button) { justify-content: center; } }
</style>
