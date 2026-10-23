<script setup lang="ts">
import { computed } from 'vue';
import type { DeliveryRun } from '../../application/delivery-contracts';
import { deliveryBehaviorNodes, deliveryInvocationLimits, deliveryLimitDuration } from '../delivery-behavior-view';
import { date } from '../store';
const props = defineProps<{ run: DeliveryRun }>();
const nodes = computed(() => deliveryBehaviorNodes(props.run.profile, props.run.decision));
const selected = computed(() => nodes.value.find(node => node.selected));
const limits = computed(() => deliveryInvocationLimits(props.run));
</script>
<template>
  <details class="behavior-inspector">
    <summary>Why the worker chose this action</summary>
    <p>{{ run.decision.reason }}</p>
    <dl>
      <div><dt>Selected action</dt><dd>{{ run.decision.selectedAction.replaceAll('_', ' ') }}</dd></div>
      <div><dt>Waiting for</dt><dd>{{ run.decision.waitingFor || 'No wait condition recorded' }}</dd></div>
      <div><dt>Behavior profile</dt><dd>{{ run.profile.id }} · version {{ run.profile.version }}</dd></div>
      <div><dt>Selected branch</dt><dd>{{ selected?.path.join(' → ') || run.decision.selectedNode }}</dd></div>
      <div><dt>Repair attempts</dt><dd>{{ run.repairAttempts }} / {{ run.maxRepairAttempts }}</dd></div>
      <div><dt>Invocation runtime limit</dt><dd>{{ deliveryLimitDuration(limits.maxRuntimeMs) }}</dd></div>
      <div><dt>Command timeout</dt><dd>{{ deliveryLimitDuration(limits.commandTimeoutMs) }}</dd></div>
      <div><dt>Tool call limit</dt><dd>{{ limits.maxToolCalls ?? 'Not recorded' }}</dd></div>
      <div v-if="limits.deadline"><dt>Active invocation deadline</dt><dd>{{ date(limits.deadline) }}</dd></div>
    </dl>
    <p class="caption">{{ limits.accepted ? 'These effective limits were retained when this delivery was admitted. They do not predict completion time.' : limits.stepId ? 'Execution limits come from the recorded dispatch for step ' + limits.stepId + '. They are limits, not an estimated completion time.' : 'No invocation settings are recorded yet. A future dispatch must retain its effective limits.' }}</p>
    <details><summary>Inspect the authored behavior</summary>
      <ol aria-label="Behavior nodes and observed conditions" class="behavior-nodes">
        <li v-for="node in nodes" :key="node.id" :class="{ selected: node.selected }" :style="{ '--node-depth': Math.min(node.depth, 4) }">
          <div><code>{{ node.id }}</code><strong>{{ node.label }}</strong></div>
          <span v-if="node.selected">Selected action</span><span v-else-if="node.type === 'condition'">{{ node.inspected === 'met' ? 'Condition met' : node.inspected === 'not_met' ? 'Condition not met' : 'Not inspected in this decision' }}</span><span v-else>{{ node.type }}</span>
        </li>
      </ol>
      <p class="caption">Unvisited branches have no recorded result. This inspector explains the selected behavior; it does not execute nodes.</p>
    </details>
    <details><summary>Recorded identity</summary><dl><div><dt>Delivery run</dt><dd>{{ run.id }}</dd></div><div><dt>Accepted input revision</dt><dd>{{ run.inputRevision }}</dd></div><div><dt>Behavior digest</dt><dd>{{ run.profileDigest }}</dd></div></dl></details>
  </details>
</template>
<style scoped>
.behavior-inspector { border-top: 1px solid var(--ui-border); min-width: 0; }summary { min-height: 44px; padding-block: var(--space-3); cursor: pointer; font-size: .875rem; }p { font-size: .875rem; line-height: 1.65; max-width: 80ch; }dl { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: var(--space-4); }dt,.caption { color: var(--ui-text-muted); font-size: .8125rem; }dd { margin: var(--space-1) 0 0; font-size: .875rem; overflow-wrap: anywhere; }.behavior-nodes { list-style: none; margin: 0; padding: 0; }.behavior-nodes li { border-left: 2px solid var(--ui-border); padding: var(--space-3); margin-left: calc(var(--node-depth) * 12px); display: flex; justify-content: space-between; gap: var(--space-3); font-size: .8125rem; }.behavior-nodes li.selected { border-color: var(--ui-primary); background: var(--ui-bg-elevated); }.behavior-nodes code { display: block; color: var(--ui-text-muted); overflow-wrap: anywhere; }.behavior-nodes strong { display: block; margin-top: var(--space-1); font-weight: 550; }.behavior-nodes span { color: var(--ui-text-muted); text-align: right; }@media(max-width:560px) { dl { grid-template-columns: 1fr; }.behavior-nodes li { flex-direction: column; }.behavior-nodes span { text-align: left; } }
</style>
