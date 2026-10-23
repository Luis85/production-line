<script setup lang="ts">
import { computed } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import type { WorkerRequest } from '../../application/request-gates';
import type { DeliveryCriterionDecisionKind } from '../../application/delivery-criterion-decisions';
import { deliveryCriterionDecision } from '../../application/delivery-criterion-decisions';
import { deliveryDecisionSubject } from '../delivery-decision-subject';
import { acceptedDeliveryPolicy } from '../delivery-policy-view';
import type { GateCommandFields } from '../request-gate-controller';
const props = defineProps<{ subject: WorkerRequest; disabled: boolean; draft: (key: string) => string }>();
const emit = defineEmits<{ command: [GateCommandFields]; update: [key: string, value: string] }>();
const review = computed(() => deliveryDecisionSubject(props.subject));
const policy = computed(() => acceptedDeliveryPolicy(props.subject.input.context)?.profile.exceptions);
const criteria = computed(() => review.value?.criteria.filter(item => policy.value?.exemptibleCriteria.includes(item.id) || policy.value?.notApplicableCriteria.includes(item.id)) ?? []);
const key = (id: string) => 'exception:' + review.value?.candidate.candidateDigest + ':' + id;
const current = (id: string) => { try { return review.value ? deliveryCriterionDecision(id, review.value.candidate, props.subject.delivery?.criterionDecisions, policy.value) : undefined; } catch { return undefined; } };
function decide(id: string, kind: DeliveryCriterionDecisionKind) {
  const candidate = review.value?.candidate, reason = props.draft(key(id)).trim();
  if (props.disabled || !candidate || !reason || !policy.value?.[kind === 'exempted' ? 'exemptibleCriteria' : 'notApplicableCriteria'].includes(id)) return;
  emit('command', { action: 'criterion_decision', deliveryRunId: candidate.runId, inputRevision: candidate.inputRevision, candidateCommit: candidate.candidateCommit, candidateDigest: candidate.candidateDigest, criterionDecision: { criterionId: id, kind, reason } });
}
</script>
<template>
  <details v-if="criteria.length && review" class="delivery-detail"><summary>Policy-permitted criterion decisions</summary><p>An exception is an explicit operator decision for this exact candidate. It preserves the observed result, records a reason, and does not turn a failed check into a pass.</p><p v-if="!review.packaged" class="caption">This is a retained settled checkpoint. Human criteria become available only in a review package. A decision does not itself retry work or establish a verified result.</p><p class="caption">Candidate <code>{{ review.candidate.candidateCommit }}</code> · revision {{ review.candidate.inputRevision }}</p>
    <article v-for="criterion in criteria" :key="criterion.id" class="entry"><h4>{{ criterion.description }}</h4><p><code>{{ criterion.id }}</code> · observed {{ review.results.find(item => item.criterionId === criterion.id)?.observedStatus ?? review.results.find(item => item.criterionId === criterion.id)?.status ?? 'unknown' }}</p><p v-if="current(criterion.id)">{{ current(criterion.id)!.kind.replaceAll('_', ' ') }} · {{ current(criterion.id)!.reason }}</p><template v-else><label :for="'criterion-decision-' + criterion.id">Reason for this decision</label><textarea :id="'criterion-decision-' + criterion.id" :value="draft(key(criterion.id))" maxlength="4000" @input="emit('update', key(criterion.id), ($event.target as HTMLTextAreaElement).value)" /><div class="actions"><UButton v-if="policy?.exemptibleCriteria.includes(criterion.id)" type="button" variant="outline" :disabled="disabled || !draft(key(criterion.id)).trim()" @click="decide(criterion.id, 'exempted')">Record exemption</UButton><UButton v-if="policy?.notApplicableCriteria.includes(criterion.id)" type="button" variant="outline" color="neutral" :disabled="disabled || !draft(key(criterion.id)).trim()" @click="decide(criterion.id, 'not_applicable')">Record not applicable</UButton></div></template></article>
  </details>
</template>
<style scoped src="./delivery-detail.css"></style>
