<script setup lang="ts">
import { ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import type { DeliveryDependencyPlan } from '../../application/delivery-dependency-plan';
import { request, state } from '../store';
const props = defineProps<{ requestId: string; projectId?: string }>();
const plan = ref<DeliveryDependencyPlan | null>(null), loading = ref(false), error = ref('');
let revision = 0;
watch([() => props.requestId, () => props.projectId, () => state.unlocked], () => { revision++; plan.value = null; error.value = ''; loading.value = false; });
async function inspect() {
  if (loading.value || !state.unlocked) return;
  const current = ++revision; loading.value = true; error.value = '';
  try { const result = await request<DeliveryDependencyPlan>('/api/features', 'POST', { action: 'dependency_plan', id: props.requestId, ...(props.projectId ? { projectId: props.projectId } : {}) }); if (current === revision && state.unlocked) plan.value = result; }
  catch (cause) { if (current === revision) error.value = (cause as Error).message; }
  finally { if (current === revision) loading.value = false; }
}
const labels = { ready: 'Ready in this baseline', waiting_acceptance: 'Waiting for human acceptance', waiting_integration: 'Accepted · code not integrated', blocked: 'Blocked' };
</script>
<template>
  <details class="delivery-detail"><summary>Dependency plan</summary>
    <p>Inspect the reachable requests and execution waves without dispatching work or merging code. This snapshot is checked again at admission.</p>
    <UButton type="button" variant="outline" color="neutral" :loading="loading" :disabled="!state.unlocked" @click="inspect">{{ plan ? 'Refresh dependency plan' : 'Inspect dependencies' }}</UButton>
    <p v-if="error" role="alert" class="error-text">{{ error }}</p>
    <template v-if="plan"><h3>{{ plan.ready ? 'Dependency requirements satisfied' : 'Dependency work still required' }}</h3><p class="caption">Target {{ plan.target }} · baseline <code>{{ plan.baseline }}</code></p>
      <ul v-if="plan.blockers.length"><li v-for="(blocker,index) in plan.blockers" :key="index"><strong>{{ blocker.nodeId }}</strong>: {{ blocker.reason }}</li></ul>
      <ol aria-label="Dependency execution waves"><li v-for="(wave,index) in plan.waves" :key="index"><strong>Wave {{ index + 1 }}</strong> · {{ wave.join(', ') }}</li></ol>
      <article v-for="node in plan.nodes" :key="node.id" class="entry"><h4>{{ node.id }} · {{ labels[node.state] }}</h4><p v-if="node.dependsOn.length">Requires {{ node.dependsOn.join(', ') }}</p><p v-if="node.accepted" class="caption">Accepted request revision {{ node.accepted.inputRevision }}. {{ node.receipt ? 'Baseline incorporation is recorded.' : 'Acceptance is not baseline incorporation.' }}</p><p v-if="node.receipt?.candidateCommit" class="caption">Incorporated candidate <code>{{ node.receipt.candidateCommit }}</code></p></article>
    </template>
  </details>
</template>
<style scoped src="./delivery-detail.css"></style>
