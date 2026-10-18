<script setup lang="ts">
import { useId } from 'vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import type { GateEvaluation, GateStage, GateFact } from '../../application/request-gates';
defineProps<{ stage: GateStage; evaluation?: GateEvaluation }>();
const titleId = useId();
const labels: Record<GateFact, string> = {
  'input.kind': 'Request type', 'input.titleLength': 'Title length', 'input.messageLength': 'Instruction length',
  'input.criteriaCount': 'Acceptance criteria', 'input.approvedFileCount': 'Approved files', 'input.approvedBytes': 'Approved file size',
  'input.pathsValid': 'Approved paths valid', 'output.nonEmpty': 'Result recorded', 'output.protocolValid': 'Valid model response',
  'output.patchPresent': 'Patch available', 'output.changedFileCount': 'Changed files', 'output.verificationPassed': 'Required checks passed',
  'output.requiredCheckCount': 'Required checks', 'output.candidateDigest': 'Recorded candidate', 'execution.recoverySafe': 'Safe to resume',
  'execution.outcome': 'Execution outcome', 'pending.count': 'Pending questions', 'findings.blockingCount': 'Blocking findings',
  'operator.accepted': 'Human acceptance', 'tests.passed': 'Tests passed', 'build.passed': 'Build passed',
};
const observed = (value: string | number | boolean | null) => value === null ? 'Not recorded' : typeof value === 'boolean' ? value ? 'Yes' : 'No' : String(value);
const resultLabel = { pass: 'Passed', fail: 'Not met', unknown: 'Unknown' };
</script>
<template>
  <section class="request-gate-stage" :aria-labelledby="titleId">
    <h3 :id="titleId">{{ stage === 'ready' ? 'Definition of ready' : 'Definition of done' }}</h3>
    <p v-if="!evaluation">No evaluation for the current approved input{{ stage === 'done' ? ' and known output' : '' }}.</p>
    <div v-else class="request-gate-table">
      <table role="table">
        <caption class="sr-only">{{ stage === 'ready' ? 'Readiness' : 'Completion' }} checks for the current accepted request</caption>
        <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Check</th><th scope="col" role="columnheader">Expected</th><th scope="col" role="columnheader">Observed evidence</th><th scope="col" role="columnheader">Result</th></tr></thead>
        <tbody role="rowgroup">
          <tr v-for="rule in evaluation.rules" :key="rule.ruleId" role="row">
            <th scope="row" role="rowheader"><strong>{{ labels[rule.fact] ?? rule.ruleId }}</strong><small>{{ rule.ruleId }}</small></th>
            <td role="cell"><span class="mobile-label" aria-hidden="true">Expected</span>{{ observed(rule.expected) }}</td>
            <td role="cell"><span class="mobile-label" aria-hidden="true">Observed</span>{{ observed(rule.observed) }}</td>
            <td role="cell"><span class="mobile-label" aria-hidden="true">Result</span><UBadge :color="rule.result === 'pass' ? 'success' : 'warning'" variant="subtle">{{ resultLabel[rule.result] }}</UBadge></td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
<style scoped>
.request-gate-stage { min-width: 0; }
.request-gate-stage h3 { margin: 20px 0 12px; font-size: 16px; }
.request-gate-stage p { margin: 0; max-width: 75ch; line-height: 1.65; color: var(--ui-text-muted); overflow-wrap: anywhere; }
.request-gate-table { min-width: 0; width: 100%; max-width: 100%; margin: 16px 0; }
.request-gate-table table { width: 100%; border-collapse: collapse; table-layout: fixed; text-align: left; font-size: .8125rem; }
.request-gate-table th, .request-gate-table td { padding: 12px 8px; border-bottom: 1px solid var(--ui-border); vertical-align: top; min-width: 0; overflow-wrap: anywhere; line-height: 1.6; }
.request-gate-table th:first-child { width: 34%; }
.request-gate-table tbody th { font-weight: 400; }
.request-gate-table strong { font-weight: 600; color: var(--ui-text-highlighted); }
.request-gate-table small { display: block; margin-top: 6px; color: var(--ui-text-muted); font-size: .75rem; }
.mobile-label { display: none; }
@media (max-width: 600px) {
  .request-gate-table table, .request-gate-table tbody { display: block; }
  .request-gate-table thead { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .request-gate-table tbody tr { display: grid; grid-template-columns: minmax(0, 1fr); padding-block: 12px; border-bottom: 1px solid var(--ui-border); }
  .request-gate-table tbody th { width: auto; padding: 4px 0 8px; border: 0; }
  .request-gate-table td { display: grid; grid-template-columns: 100px minmax(0, 1fr); align-items: baseline; gap: 12px; padding: 5px 0; border: 0; }
  .request-gate-table td :deep(span) { justify-self: start; }
  .mobile-label { display: inline; color: var(--ui-text-muted); }
}
</style>
