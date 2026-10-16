<script setup lang="ts">
import { computed } from 'vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import { candidateEvidenceView, type DevelopmentTaskView } from '../candidate-evidence';
const props = defineProps<{ task: DevelopmentTaskView; showReviewLink?: boolean }>();
const view = computed(() => candidateEvidenceView(props.task));
const when = (value: string) => new Date(value).toLocaleString();
</script>
<template>
  <section class="candidate-evidence" aria-label="Implementation and verification">
    <h4>{{ view.title }}</h4>
    <p class="candidate-summary" role="status">{{ view.description }}</p>
    <RouterLink v-if="showReviewLink && (task.hasPatch || task.patch)" class="candidate-review" :to="{ path: '/history', query: { fileId: task.id } }">Review patch</RouterLink>
    <details class="candidate-details">
      <summary>{{ view.implementation ? 'Implementation scope & required checks' : 'Approved file scope' }}</summary>
      <template v-if="view.implementation">
        <p v-if="task.developmentEvidence" class="candidate-time">Last recorded <time :datetime="task.developmentEvidence.updatedAt">{{ when(task.developmentEvidence.updatedAt) }}</time></p>
        <ul class="candidate-checks" aria-label="Required feature checks">
          <li v-for="check in view.checks" :key="check.id">
            <div class="check-result"><strong>{{ check.name }}</strong><UBadge :color="check.passed ? 'success' : check.status === 'Failed' || check.status === 'Interrupted' ? 'warning' : 'neutral'" variant="subtle">{{ check.status }}</UBadge></div>
            <p v-if="check.status === 'Needs rerun'" class="check-help">This result does not verify the recorded changes and required check definition.</p>
            <details v-if="check.receipt" class="check-output">
              <summary>View check result</summary>
              <p>Exit code: {{ check.receipt.exitCode ?? 'Unavailable' }} · Finished {{ when(check.receipt.finishedAt) }}</p>
              <p v-if="check.receipt.truncated">Output was truncated; this is not the complete command log.</p>
              <template v-if="check.receipt.stdout"><h5>Output</h5><pre tabindex="0" :aria-label="check.name + ' output'">{{ check.receipt.stdout }}</pre></template>
              <template v-if="check.receipt.stderr"><h5>Error output</h5><pre tabindex="0" :aria-label="check.name + ' error output'">{{ check.receipt.stderr }}</pre></template>
              <p v-if="!check.receipt.stdout && !check.receipt.stderr">The command returned no captured output.</p>
            </details>
          </li>
        </ul>
        <h5>Recorded changed files</h5>
        <ul v-if="view.changedPaths.length" class="candidate-paths"><li v-for="path in view.changedPaths" :key="path"><code>{{ path }}</code></li></ul>
        <p v-else>No changed files recorded yet.</p>
      </template>
      <template v-if="view.implementation && task.worktree"><h5>Implementation worktree</h5><p class="candidate-worktree"><code>{{ task.worktree }}</code></p></template>
      <h5>Approved editable paths</h5>
      <ul class="candidate-paths"><li v-for="path in view.approvedPaths" :key="path"><code>{{ path }}</code></li></ul>
      <p v-if="view.implementation" class="candidate-boundary">The request keeps this file scope and verification plan. Grant changes do not expand it.</p>
    </details>
  </section>
</template>
<style scoped>
.candidate-evidence { margin-block: var(--space-4); padding-block: var(--space-4); border-block: 1px solid var(--ui-border); min-width: 0; font-size: .8125rem; line-height: 1.6; }
h4 { margin: 0 0 var(--space-2); font-size: .9375rem; font-weight: 650; color: var(--ui-text-highlighted); }
h5 { margin: var(--space-4) 0 var(--space-2); font-size: .8125rem; font-weight: 600; color: var(--ui-text-highlighted); }
p { margin: var(--space-2) 0; color: var(--ui-text-muted); }
.candidate-summary { margin-bottom: 0; }
.candidate-review { display: inline-flex; align-items: center; min-height: 44px; color: var(--ui-primary); text-underline-offset: 3px; }
.candidate-worktree code { white-space: normal; overflow-wrap: anywhere; }
summary { min-height: 44px; padding-block: var(--space-3); cursor: pointer; color: var(--ui-text-highlighted); }
.candidate-checks { padding: 0; margin: 0; list-style: none; }
.candidate-checks > li { padding-block: var(--space-3); border-bottom: 1px solid var(--ui-border); }
.check-result { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-2); }
.check-result strong { overflow-wrap: anywhere; }
.check-help, .candidate-time { font-size: .75rem; }
.check-output pre { max-width: 100%; max-height: 240px; overflow: auto; padding: var(--space-3); background: var(--ui-bg); border-radius: 8px; font-size: .75rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.candidate-paths { margin: 0; padding-left: var(--space-4); }
.candidate-paths code { white-space: normal; overflow-wrap: anywhere; }
.candidate-boundary { margin-top: var(--space-4); }
</style>
