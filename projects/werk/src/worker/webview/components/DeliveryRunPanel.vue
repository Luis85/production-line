<script setup lang="ts">
import { computed, ref } from 'vue';
import type { WorkerRequest } from '../../application/request-gates';
import { deliveryControlNotice, deliveryLifecycleLabels, deliveryPhaseLabels, deliveryStatusLabels } from '../delivery-view';
import { date } from '../store';
import MessageContent from './MessageContent.vue';
import { acceptedDeliveryPolicy } from '../delivery-policy-view';

const props = defineProps<{ request: WorkerRequest }>();
const run = computed(() => props.request.delivery);
const policy = computed(() => acceptedDeliveryPolicy(props.request.input.context));
const filter = ref('all');
const steps = computed(() => run.value?.steps.filter(step => filter.value === 'all' || step.phase === filter.value) ?? []);
const stepStatus = { running: 'Running', completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted', outcome_unknown: 'Outcome unknown' };
</script>
<template>
  <section v-if="run" id="review-progress" class="delivery-run" aria-labelledby="delivery-run-title">
    <header><h2 id="delivery-run-title">Delivery progress</h2><a href="#review-decision">Request controls</a></header>
    <dl class="delivery-state">
      <div v-if="request.lifecycle"><dt>Feature Request</dt><dd>{{ deliveryLifecycleLabels[request.lifecycle] }}</dd></div>
      <div><dt>Run status</dt><dd>{{ deliveryStatusLabels[run.status] }}</dd></div>
      <div><dt>Current phase</dt><dd>{{ deliveryPhaseLabels[run.phase] }}</dd></div>
    </dl>
    <p class="delivery-reason">{{ run.decision.reason }}</p>
    <p v-if="run.decision.waitingFor"><strong>Next expected event:</strong> {{ run.decision.waitingFor }}</p>
    <p v-if="deliveryControlNotice(run)" class="delivery-notice" role="status">{{ deliveryControlNotice(run) }}</p>
    <ul v-if="run.holds.length" class="delivery-holds" aria-label="Reasons work is held"><li v-for="hold in run.holds" :key="hold.code">{{ hold.reason }}</li></ul>
    <p class="delivery-caption">Started {{ date(run.startedAt) }}<template v-if="run.finishedAt"> · Finished {{ date(run.finishedAt) }}</template> · Repair attempts {{ run.repairAttempts }} of {{ run.maxRepairAttempts }}</p>
    <details v-if="policy" class="delivery-policy"><summary>Accepted quality profile and baseline</summary><dl class="delivery-identities"><div><dt>Quality profile</dt><dd>{{ policy.profile.id }}</dd></div><div><dt>Baseline commit</dt><dd>{{ policy.baseline }}</dd></div><div><dt>Repair budget</dt><dd>{{ policy.profile.maxRepairAttempts }} attempts</dd></div><div><dt>Review notes directory</dt><dd>{{ policy.configuration.reviewDirectory }}</dd></div></dl><h3>Protected verification inputs</h3><ul><li v-for="path in policy.profile.verificationInputs" :key="path"><code>{{ path }}</code></li></ul><p class="delivery-caption">These accepted settings remain tied to this run. Later project policy changes do not rewrite its evidence.</p></details>
    <details class="delivery-behavior">
      <summary>Why the worker chose this action</summary>
      <dl class="delivery-identities"><div><dt>Selected action</dt><dd>{{ run.decision.selectedAction.replaceAll('_', ' ') }}</dd></div><div><dt>Behavior profile</dt><dd>{{ run.decision.profileId }} · version {{ run.decision.profileVersion }}</dd></div><div><dt>Delivery run</dt><dd>{{ run.id }}</dd></div><div><dt>Accepted request revision</dt><dd>{{ run.inputRevision }}</dd></div></dl>
      <ul v-if="run.decision.conditions.length" class="delivery-conditions" aria-label="Evaluated behavior conditions"><li v-for="condition in run.decision.conditions" :key="condition.nodeId"><span>{{ condition.condition.replaceAll('_', ' ') }}</span><strong>{{ condition.result ? 'Met' : 'Not met' }}</strong></li></ul>
      <p v-else class="delivery-caption">No evaluated conditions are retained for this decision.</p>
    </details>
    <details v-if="run.checkpoints?.length" class="delivery-checkpoints"><summary>Retained Git checkpoints · {{ run.checkpoints.length }}</summary><p class="delivery-caption">These local commits preserve observed source for inspection or recovery. A checkpoint does not establish passed checks or human acceptance.</p><ol class="delivery-steps"><li v-for="checkpoint in run.checkpoints" :key="checkpoint.candidateCommit"><p class="delivery-caption">{{ date(checkpoint.createdAt) }} · Request revision {{ checkpoint.inputRevision }}</p><dl class="delivery-identities"><div><dt>Local checkpoint branch</dt><dd>{{ checkpoint.branch }}</dd></div><div><dt>Checkpoint commit</dt><dd>{{ checkpoint.candidateCommit }}</dd></div><div><dt>Baseline commit</dt><dd>{{ checkpoint.baseline }}</dd></div><div><dt>Observed source digest</dt><dd>{{ checkpoint.candidateDigest }}</dd></div></dl></li></ol></details>
    <details v-if="run.recoveries?.length" class="delivery-recovery-history"><summary>Operator process confirmations · {{ run.recoveries.length }}</summary><ol class="delivery-steps"><li v-for="receipt in run.recoveries" :key="receipt.operationId"><strong>Operator-attested stop</strong><p class="delivery-caption">{{ date(receipt.at) }} · The operator inspected and stopped remaining processes. This does not establish the previous operation’s result.</p><MessageContent :text="receipt.note" /><dl class="delivery-identities"><div><dt>Observed workspace digest</dt><dd>{{ receipt.candidateDigest }}</dd></div><div><dt>Confirmation operation</dt><dd>{{ receipt.operationId }}</dd></div></dl></li></ol></details>
    <div class="delivery-step-heading"><h3>Recorded steps</h3><div><label for="delivery-step-filter">Show phase</label><select id="delivery-step-filter" v-model="filter"><option value="all">All phases</option><option v-for="(label, phase) in deliveryPhaseLabels" :key="phase" :value="phase">{{ label }}</option></select></div></div>
    <ol v-if="steps.length" class="delivery-steps">
      <li v-for="step in steps" :key="step.id">
        <div class="delivery-step-title"><strong>{{ deliveryPhaseLabels[step.phase] }}</strong><span>{{ stepStatus[step.status] }}</span></div>
        <p class="delivery-caption">{{ date(step.startedAt) }}<template v-if="step.finishedAt"> → {{ date(step.finishedAt) }}</template></p>
        <MessageContent v-if="step.detail" :text="step.detail" />
        <details><summary>Step evidence and correlation</summary><dl class="delivery-identities"><div><dt>Step ID</dt><dd>{{ step.id }}</dd></div><div v-if="step.invocationRunId"><dt>Provider invocation</dt><dd>{{ step.invocationRunId }}</dd></div><div v-if="step.turnId"><dt>Model turn</dt><dd>{{ step.turnId }}</dd></div><div v-if="step.evidenceDigest"><dt>Evidence digest</dt><dd>{{ step.evidenceDigest }}</dd></div></dl><MessageContent v-if="step.result?.type === 'completed'" :text="step.result.text" /><p v-else-if="step.result" class="delivery-caption">Recorded model outcome: {{ step.result.type.replaceAll('_', ' ') }}. See the request’s questions and evidence for the next action.</p></details>
      </li>
    </ol>
    <p v-else class="delivery-caption">{{ run.steps.length ? 'No recorded steps match this phase.' : 'The worker has not recorded a delivery step yet. Its saved decision above explains what happens next.' }}</p>
    <details v-if="request.deliveryHistory?.length"><summary>Earlier delivery runs · {{ request.deliveryHistory.length }}</summary><ol class="delivery-steps"><li v-for="previous in request.deliveryHistory" :key="previous.id"><strong>Request revision {{ previous.inputRevision }} · {{ deliveryStatusLabels[previous.status] }}</strong><p class="delivery-caption">{{ date(previous.startedAt) }} · {{ previous.id }}</p><p>{{ previous.decision.reason }}</p><details v-if="previous.review"><summary>Retained review note</summary><MessageContent :text="previous.review.markdown" /></details></li></ol></details>
  </section>
</template>
<style scoped>
.delivery-run { padding-block: var(--space-6); border-bottom: 1px solid var(--ui-border); min-width: 0; scroll-margin-top: var(--space-6); }
header, .delivery-step-heading, .delivery-step-title { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3); }
h2 { margin: 0; font-size: 1.125rem; font-weight: 650; } h3 { margin: 0; font-size: 1rem; }
header a { min-height: 44px; display: inline-flex; align-items: center; color: var(--ui-primary); font-size: .875rem; }
.delivery-state, .delivery-identities { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: var(--space-4); margin-block: var(--space-4); }
dt, .delivery-caption { color: var(--ui-text-muted); font-size: .8125rem; line-height: 1.65; } dd { margin: var(--space-1) 0 0; overflow-wrap: anywhere; font-size: .875rem; } .delivery-state dd { font-weight: 650; }
.delivery-reason { max-width: 75ch; } p, .delivery-holds { line-height: 1.65; overflow-wrap: anywhere; } .delivery-notice { color: var(--ui-warning); }
summary { min-height: 44px; padding-block: var(--space-3); cursor: pointer; font-size: .875rem; } .delivery-behavior { border-top: 1px solid var(--ui-border); }
.delivery-conditions, .delivery-steps { list-style: none; padding: 0; margin: 0; }.delivery-conditions li { display: flex; justify-content: space-between; gap: var(--space-4); padding-block: var(--space-2); font-size: .875rem; }
.delivery-step-heading { margin-top: var(--space-6); }.delivery-step-heading > div { display: flex; align-items: center; gap: var(--space-3); font-size: .875rem; }
select { background: var(--ui-bg); color: var(--ui-text); border: 1px solid var(--ui-border); border-radius: 6px; min-height: 44px; padding-inline: var(--space-3); max-width: 100%; }
.delivery-steps li { padding-block: var(--space-4); border-bottom: 1px solid var(--ui-border); }.delivery-steps li:last-child { border-bottom: 0; }.delivery-step-title { font-size: .875rem; }.delivery-step-title span { color: var(--ui-text-muted); }.delivery-identities { grid-template-columns: repeat(2,minmax(0,1fr)); }
@media (max-width: 560px) { .delivery-state, .delivery-identities { grid-template-columns: 1fr; }.delivery-step-heading > div { width: 100%; justify-content: space-between; } }
</style>
