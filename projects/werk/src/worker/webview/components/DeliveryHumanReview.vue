<script setup lang="ts">
import type { DeliveryReviewPackage } from '../../application/delivery-review-contracts';
import { humanReviewDraftKey } from '../delivery-human-review';
import MessageContent from './MessageContent.vue';
const props = defineProps<{ review: DeliveryReviewPackage; disabled: boolean; draft: (key: string) => string }>();
const emit = defineEmits<{ update: [key: string, value: string] }>();
const key = (id: string, field: 'outcome' | 'reason') => humanReviewDraftKey(props.review, id, field);
const inputId = (id: string, field: string) => 'human-review-' + encodeURIComponent(id) + '-' + field;
</script>
<template>
  <div class="human-review">
    <p>Record an outcome and observation for each required human criterion. Acceptance applies only to candidate <code>{{ review.candidate.candidateCommit }}</code>.</p>
    <fieldset v-for="criterion in review.criteria.filter(item => item.evaluator === 'human')" :key="criterion.id" :disabled="disabled">
      <legend>{{ criterion.mandatory ? 'Required human review' : 'Advisory human review' }}</legend>
      <MessageContent :text="criterion.description" />
      <label :for="inputId(criterion.id, 'outcome')">Review outcome</label>
      <select :id="inputId(criterion.id, 'outcome')" :value="draft(key(criterion.id, 'outcome'))" @change="emit('update', key(criterion.id, 'outcome'), ($event.target as HTMLSelectElement).value)">
        <option value="">Not reviewed</option><option value="passed">Passed</option><option value="failed">Needs changes</option>
      </select>
      <label :for="inputId(criterion.id, 'reason')">What you checked or what needs to change</label>
      <textarea :id="inputId(criterion.id, 'reason')" :value="draft(key(criterion.id, 'reason'))" maxlength="8000" rows="3" @input="emit('update', key(criterion.id, 'reason'), ($event.target as HTMLTextAreaElement).value)" />
    </fieldset>
  </div>
</template>
<style scoped>
.human-review { display: grid; gap: var(--space-4); min-width: 0; }.human-review p { line-height: 1.65; font-size: .875rem; }.human-review code { overflow-wrap: anywhere; font-size: .8125rem; }fieldset { border: 0; border-top: 1px solid var(--ui-border); padding: var(--space-4) 0 0; margin: 0; min-width: 0; }legend { padding-right: var(--space-3); font-size: .8125rem; color: var(--ui-text-muted); }label { display: block; font-size: .875rem; margin-block: var(--space-3) var(--space-2); }select, textarea { display: block; width: 100%; color: var(--ui-text); background: var(--ui-bg); border: 1px solid var(--ui-border); border-radius: 6px; min-height: 44px; padding: var(--space-3); font: inherit; }textarea { resize: vertical; }fieldset:disabled { opacity: .65; }
</style>
