<script setup lang="ts">
import UButton from '@nuxt/ui/components/Button.vue';
import type { GateEvaluation, WorkerRequest } from '../../application/request-gates';
import type { GateCommandFields } from '../request-gate-controller';
import { readinessDecision } from '../delivery-readiness-view';
import { date } from '../store';
import MessageContent from './MessageContent.vue';
const props = defineProps<{ subject: WorkerRequest; evaluation?: GateEvaluation | null; disabled: boolean; draft: (key: string) => string }>();
const emit = defineEmits<{ command: [GateCommandFields]; update: [key: string, value: string] }>();
const key = (id: string) => 'readiness:' + props.evaluation?.readiness?.assessment?.id + ':' + id;
function decide(id: string, outcome: 'accepted' | 'rejected') { if (props.disabled) return; const fields = readinessDecision(props.subject, props.evaluation, id, outcome, props.draft(key(id))); if (fields) emit('command', fields); }
</script>
<template>
  <section v-if="evaluation?.readiness?.configured" class="delivery-detail" aria-labelledby="readiness-assessment-title">
    <h3 id="readiness-assessment-title">Readiness judgments and assumptions</h3>
    <p>{{ evaluation.readiness.message }}</p><p class="caption">Accepting a proposal supplements intent. It does not answer a blocking question, clear a failed finding or establish that tests passed.</p>
    <dl v-if="evaluation.readiness.assessment"><div><dt>Evaluator</dt><dd>{{ evaluation.readiness.assessment.evaluator.kind }} · {{ evaluation.readiness.assessment.evaluator.id }}</dd></div><div><dt>Assessed input</dt><dd>Revision {{ evaluation.readiness.assessment.inputRevision }} · {{ date(evaluation.readiness.assessment.at) }}</dd></div></dl>
    <ul><li v-for="condition in evaluation.readiness.conditions" :key="condition.id"><strong>{{ condition.id }} · {{ condition.outcome }}</strong><p>{{ condition.reason }}</p></li></ul>
    <article v-for="proposal in evaluation.readiness.proposals" :key="proposal.id" class="entry"><h4>{{ proposal.kind }} · {{ proposal.status === 'policy_permitted' ? 'Permitted by accepted low-impact policy' : proposal.status }} · {{ proposal.impact }} impact</h4><MessageContent :text="proposal.text" /><p v-if="proposal.blockingQuestionIds.length">Still requires answers to {{ proposal.blockingQuestionIds.join(', ') }}.</p><p v-if="proposal.decision" class="caption">Operator decision: {{ proposal.decision.reason }} · {{ date(proposal.decision.at) }}</p>
      <template v-if="!['accepted', 'rejected'].includes(proposal.status)"><label :for="'readiness-note-' + proposal.id">Decision reason</label><textarea :id="'readiness-note-' + proposal.id" :value="draft(key(proposal.id))" maxlength="4000" @input="emit('update', key(proposal.id), ($event.target as HTMLTextAreaElement).value)" /><div class="actions"><UButton type="button" variant="outline" :disabled="disabled || !draft(key(proposal.id)).trim()" @click="decide(proposal.id, 'accepted')">Accept this proposal</UButton><UButton type="button" color="neutral" variant="outline" :disabled="disabled || !draft(key(proposal.id)).trim()" @click="decide(proposal.id, 'rejected')">Reject this proposal</UButton></div></template>
    </article>
  </section>
</template>
<style scoped src="./delivery-detail.css"></style>
