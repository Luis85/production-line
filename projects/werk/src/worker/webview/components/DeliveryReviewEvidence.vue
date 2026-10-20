<script setup lang="ts">
import { computed } from 'vue';
import type { DeliveryReviewPackage } from '../../application/delivery-review-contracts';
import { date } from '../store';
import MessageContent from './MessageContent.vue';
const props = defineProps<{ review: DeliveryReviewPackage }>();
const results = computed(() => new Map(props.review.results.map(result => [result.criterionId, result])));
const labels = { passed: 'Passed', failed: 'Failed', unknown: 'Evidence unknown', stale: 'Evidence out of date', not_applicable: 'Not applicable', pending_human: 'Human review needed' };
</script>
<template>
  <section class="delivery-review-evidence" aria-labelledby="delivery-evidence-title">
    <h3 id="delivery-evidence-title">Candidate and criterion evidence</h3>
    <p class="evidence-intro">This review is tied to request revision {{ review.candidate.inputRevision }} and candidate commit <code>{{ review.candidate.candidateCommit }}</code>. A later candidate needs its own evidence and acceptance.</p>
    <dl class="candidate-identities"><div><dt>Feature branch</dt><dd>{{ review.candidate.branch }}</dd></div><div><dt>Baseline commit</dt><dd>{{ review.candidate.baseline }}</dd></div><div><dt>Review prepared</dt><dd>{{ date(review.candidate.createdAt) }}</dd></div><div><dt>Delivery status</dt><dd>Local review package<template v-if="review.reviewNotePath"> · {{ review.reviewNotePath }}</template></dd></div></dl>
    <p class="evidence-caption">No remote pull request, merge or release is recorded by this local review package.</p>
    <div class="criterion-table" role="table" aria-label="Acceptance criteria and evidence">
      <div class="criterion-heading" role="row"><span role="columnheader">Criterion</span><span role="columnheader">Evidence result</span></div>
      <div v-for="criterion in review.criteria" :key="criterion.id" role="row" class="criterion-row">
        <div role="cell"><MessageContent :text="criterion.description" /><p class="evidence-caption">{{ criterion.mandatory ? 'Required' : 'Advisory' }} · {{ criterion.evaluator === 'human' ? 'Human review' : 'Recorded check' }}</p></div>
        <div role="cell"><strong :class="'criterion-' + (results.get(criterion.id)?.status ?? 'unknown')">{{ labels[results.get(criterion.id)?.status ?? 'unknown'] }}</strong><p v-if="results.get(criterion.id)?.detail">{{ results.get(criterion.id)?.detail }}</p><details v-if="results.get(criterion.id)?.evidenceRefs.length"><summary>Evidence references</summary><ul><li v-for="reference in results.get(criterion.id)!.evidenceRefs" :key="reference"><code>{{ reference }}</code></li></ul></details></div>
      </div>
    </div>
    <details class="review-receipts"><summary>Recorded check commands and environments</summary><article v-for="check in review.checks" :key="check.evidenceRef"><h4>{{ check.presetId }} · {{ check.status }}</h4><p><code>{{ check.command.executable }} {{ check.command.args.join(' ') }}</code></p><p class="evidence-caption">{{ check.environment.platform }} · {{ check.environment.architecture }} · Node {{ check.environment.nodeVersion }} · {{ date(check.finishedAt) }}</p><dl class="candidate-identities"><div><dt>Check definition</dt><dd>{{ check.presetFingerprint }}</dd></div><div><dt>Evidence reference</dt><dd>{{ check.evidenceRef }}</dd></div></dl></article></details>
    <details class="review-package-note"><summary>Read the generated review note</summary><MessageContent :text="review.markdown" /></details>
  </section>
</template>
<style scoped>
.delivery-review-evidence { margin-block: var(--space-6); min-width: 0; }h3 { font-size: 1rem; margin: 0 0 var(--space-3); }h4 { font-size: .875rem; margin: var(--space-4) 0 var(--space-2); }p { line-height: 1.65; overflow-wrap: anywhere; }.evidence-intro { max-width: 75ch; }.evidence-caption, dt { font-size: .8125rem; color: var(--ui-text-muted); }
.candidate-identities { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: var(--space-4); margin-block: var(--space-4); }.candidate-identities dd { margin: var(--space-1) 0 0; overflow-wrap: anywhere; font-size: .875rem; }code { font-size: .8125rem; overflow-wrap: anywhere; }
.criterion-table { margin-top: var(--space-4); font-size: .875rem; }.criterion-heading, .criterion-row { display: grid; grid-template-columns: minmax(0,1.4fr) minmax(0,1fr); gap: var(--space-6); padding-block: var(--space-4); border-top: 1px solid var(--ui-border); }.criterion-heading { font-size: .8125rem; color: var(--ui-text-muted); }.criterion-row p { margin-block: var(--space-2); }.criterion-passed { color: var(--ui-success); }.criterion-failed, .criterion-stale, .criterion-pending_human { color: var(--ui-warning); }
summary { min-height: 44px; padding-block: var(--space-3); cursor: pointer; font-size: .875rem; }.review-receipts, .review-package-note { border-top: 1px solid var(--ui-border); }
@media (max-width: 560px) { .candidate-identities, .criterion-row { grid-template-columns: 1fr; gap: var(--space-3); }.criterion-heading { display: none; } }
</style>
