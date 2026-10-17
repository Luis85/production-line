<script setup lang="ts">
import type { GateEvaluation, GateStage } from '../../application/request-gates';
defineProps<{ stage: GateStage; evaluation?: GateEvaluation }>();
function observed(value: string | number | boolean | null) {
  return value === null ? "Unknown" : String(value);
}
</script>
<template>
  <section class="request-gate-stage">
    <h3>
      {{
        stage === "ready"
          ? "Definition of ready"
          : "Definition of done"
      }}
    </h3>
    <p v-if="!evaluation">
      No evaluation for the current approved input{{
        stage === "done" ? " and known output" : ""
      }}.
    </p>
    <div
      v-else
      class="request-gate-table"
      tabindex="0"
      role="region"
      :aria-label="stage + ' gate evidence'"
    >
      <table>
        <thead>
          <tr>
            <th>Check</th>
            <th>Expected</th>
            <th>Observed evidence</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="rule in evaluation.rules"
            :key="rule.ruleId"
          >
            <td>
              {{ rule.ruleId }}<small>{{ rule.fact }}</small>
            </td>
            <td>{{ observed(rule.expected) }}</td>
            <td>{{ observed(rule.observed) }}</td>
            <td>{{ rule.result }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
<style scoped>
.request-gate-stage {
  min-width: 0;
}
.request-gate-stage h3 {
  margin: 20px 0 12px;
  font-size: 16px;
}
.request-gate-stage p {
  margin: 0;
  max-width: 75ch;
  line-height: 1.65;
  color: var(--muted, #b5c4cd);
  overflow-wrap: anywhere;
}
.request-gate-table {
  min-width: 0;
  width: 100%;
  overflow: auto;
  max-width: 100%;
  margin: 16px 0;
}
.request-gate-table table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  text-align: left;
  font-size: 13px;
}
.request-gate-table th,
.request-gate-table td {
  padding: 12px 8px;
  border-bottom: 1px solid var(--line, #3b4b56);
  vertical-align: top;
  min-width: 0;
  overflow-wrap: anywhere;
}
.request-gate-table small {
  display: block;
  margin-top: 6px;
  color: var(--muted, #b5c4cd);
}
</style>
