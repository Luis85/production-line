<script lang="ts">
import { reactive, watch as watchPrivateDraft } from 'vue';
import { state as workerState } from '../store';
import { emptyReadyAnswerDraft, type ReadyAnswerDraft } from '../shared-ready-answer-controller';
const drafts = reactive(new Map<string, ReadyAnswerDraft>());
watchPrivateDraft(() => workerState.draftEpoch, () => { for (const value of drafts.values()) Object.assign(value, emptyReadyAnswerDraft()); drafts.clear(); }, { flush: 'sync' });
</script>
<script setup lang="ts">
import { computed, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UTextarea from '@nuxt/ui/components/Textarea.vue';
import type { SharedFeatureView } from '../../application/shared-intake-contract';
import type { SharedReadyReviewAnswerResult } from '../../application/shared-ready-review-answer-contracts';
import { createReadyAnswerController, sameReadyAnswerSubject } from '../shared-ready-answer-controller';
import { request, state } from '../store';
const props = defineProps<{ projectId: string; record: SharedFeatureView; disabled?: boolean }>();
const emit = defineEmits<{ published: [] }>();
const key = props.projectId + ':' + props.record.id;
if (!drafts.has(key)) drafts.set(key, emptyReadyAnswerDraft());
const draft = drafts.get(key)!;
const controller = createReadyAnswerController({ draft, active: () => state.unlocked, epoch: () => state.draftEpoch, uuid: () => crypto.randomUUID(), send: command => request<SharedReadyReviewAnswerResult>('/api/shared-intake', 'POST', command) });
const subject = computed(() => props.record.readyReview?.answerSubject);
const publication = computed(() => props.record.readyReview?.answerPublication);
const changed = computed(() => !!draft.subject && (!subject.value || !sameReadyAnswerSubject(draft.subject, subject.value)));
watch(subject, value => { if (value && draft.confirmedReviewOperationId && value.expectedReviewOperationId !== draft.confirmedReviewOperationId && !draft.pending && !draft.busy) { draft.notice = ''; draft.confirmedReviewOperationId = null; } });
function updateAnswer(value: string) { if (!draft.answer && value && subject.value) draft.subject = { ...subject.value }; draft.answer = value; }
function discard() { if (!draft.pending && !draft.busy) Object.assign(draft, emptyReadyAnswerDraft()); }
const recorded = computed(() => ['pending', 'published'].includes(publication.value?.status ?? ''));
const valid = computed(() => !!draft.pending || !recorded.value && !changed.value && !!subject.value && !!draft.answer.trim() && draft.answer.trim().length <= 8000);
async function publish() { if (props.disabled && !draft.pending) return; if (await controller.submit(props.projectId, props.record.id, subject.value)) emit('published'); }
</script>
<template>
  <form v-if="subject || draft.pending || draft.notice || recorded" class="ready-answer" :aria-busy="draft.busy" @submit.prevent="publish">
    <h4>Answer the Ready Check</h4><p>Answer the questions above without editing the worker’s review record. This commits and pushes your answer to the same project Feature Request.</p>
    <template v-if="!draft.notice && (!recorded || draft.pending)"><label :for="'ready-review-answer-' + record.id">Your answer to the Ready Check</label><UTextarea :id="'ready-review-answer-' + record.id" :model-value="draft.answer" @update:model-value="updateAnswer(String($event))" :rows="5" :maxlength="8000" :readonly="draft.busy || !!draft.pending" required class="w-full" /><p v-if="changed && !draft.pending" role="status">The Ready Check changed while you were answering. Your draft is retained. Inspect the current questions before starting a new answer.</p><UButton v-if="changed && !draft.pending" type="button" color="neutral" variant="outline" :disabled="draft.busy" @click="discard">Discard answer draft and use current questions</UButton><p v-if="draft.pending" role="status">Your exact answer is retained. Retry this saved operation before changing it or sending another answer.</p><UButton type="submit" :loading="draft.busy" :disabled="!state.unlocked || draft.busy || !valid || disabled && !draft.pending">{{ draft.pending && !draft.busy ? 'Retry same answer publication' : 'Commit and push answer' }}</UButton></template>
    <p v-if="draft.error" role="alert" class="error-text">{{ draft.error }}</p><p v-if="draft.notice" role="status">{{ draft.notice }}</p><p v-else-if="publication?.status === 'pending'" role="status">An answer publication is pending. Refresh shared intake to inspect the saved Git operation before sending another answer.</p><p v-else-if="publication?.status === 'published'" role="status">The answer was published. Refresh shared intake to observe the next Ready Check.</p>
  </form>
</template>
<style scoped>
.ready-answer { border:1px solid var(--ui-border);border-radius:8px;padding:var(--space-4);display:grid;gap:var(--space-3);min-width:0; }h4 { font-size:1rem; }p,label { font-size:.8125rem;line-height:1.7;overflow-wrap:anywhere; }label { font-weight:600; }p { color:var(--ui-text-muted); }.ready-answer :deep(button) { min-height:44px;justify-self:start; }.error-text { color:var(--ui-error); }
</style>
