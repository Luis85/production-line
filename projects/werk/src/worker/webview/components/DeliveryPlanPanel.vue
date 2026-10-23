<script setup lang="ts">
import { computed } from 'vue';
import type { WorkerRequest } from '../../application/request-gates';
import MessageContent from './MessageContent.vue';
const props = defineProps<{ subject: WorkerRequest }>();
const plan = computed(() => props.subject.delivery?.plan);
const current = computed(() => plan.value?.requestId === props.subject.id && plan.value?.inputRevision === props.subject.inputRevision && plan.value?.inputHash === props.subject.inputHash);
</script>
<template>
  <details v-if="plan" class="delivery-detail">
    <summary>{{ current ? 'Accepted delivery plan' : 'Retained delivery plan · earlier input' }}</summary>
    <p class="caption">This is the worker’s retained plan, not proof that its steps ran. Recorded delivery steps and candidate evidence establish outcomes.</p>
    <h3>Objective</h3><MessageContent :text="plan.objective" />
    <h3>Ordered work</h3><ol><li v-for="step in plan.steps" :key="step.id"><strong>{{ step.title }}</strong><p v-if="step.verification.length" class="caption">Required checks: {{ step.verification.join(', ') }}</p></li></ol>
    <h3>Acceptance criteria</h3><ul v-if="plan.criteria.length"><li v-for="(criterion, index) in plan.criteria" :key="index">{{ criterion }}</li></ul><p v-else class="caption">No explicit criteria were retained.</p>
    <h3>Approved file scope</h3><ul v-if="plan.approvedPaths.length"><li v-for="path in plan.approvedPaths" :key="path"><code>{{ path }}</code></li></ul><p v-else class="caption">No repository edits were approved.</p>
    <h3>Dependency incorporation</h3><p>Human acceptance alone does not establish that dependency code is present in the execution baseline.</p>
    <dl><div><dt>Execution baseline</dt><dd><code>{{ plan.baseline || 'Not recorded' }}</code></dd></div><div><dt>Input revision</dt><dd>{{ plan.inputRevision }}</dd></div></dl>
    <article v-for="dependency in plan.dependencies" :key="dependency.id" class="entry"><h4>{{ dependency.id }}</h4><p>{{ dependency.includesCode ? 'Accepted dependency code was verified in the recorded integration baseline.' : 'Accepted dependency does not include code changes.' }}</p><dl><div><dt>Accepted request</dt><dd>{{ dependency.requestId }} · revision {{ dependency.inputRevision }}</dd></div><div><dt>Dependency commit</dt><dd><code>{{ dependency.candidateCommit || 'No code candidate' }}</code></dd></div><div><dt>Verified integration baseline</dt><dd><code>{{ dependency.integrationBaseline || dependency.baseline }}</code></dd></div></dl></article>
    <p v-if="!plan.dependencies.length" class="caption">No dependency incorporation receipts were required.</p>
  </details>
</template>
<style scoped src="./delivery-detail.css"></style>
