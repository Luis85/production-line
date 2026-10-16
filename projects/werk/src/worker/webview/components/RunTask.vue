<script setup lang="ts">
import { computed } from 'vue';
import UInput from '@nuxt/ui/components/Input.vue';
import USelect from '@nuxt/ui/components/Select.vue';
import UTextarea from '@nuxt/ui/components/Textarea.vue';
import { state } from '../store';
const enabled = defineModel<boolean>('enabled', { required: true });
const repository = defineModel<string>('repository', { required: true });
const paths = defineModel<string>('paths', { required: true });
const repositories = computed(() => state.settings?.repositories.items ?? []);
const selectedRepository = computed(() => repositories.value.find(item => item.id === repository.value));
const requiredChecks = computed(() => state.toolAccess?.builtins.commands.filter(command => command.enabled && command.verification) ?? []);
const implementationEnabled = computed(() => !!state.toolAccess?.builtins.files && requiredChecks.value.length > 0);
</script>
<template>
  <div class="repository-file-options">
    <label class="check-label" for="request-file-changes"><input id="request-file-changes" v-model="enabled" type="checkbox" />Allow changes to approved repository files</label>
    <p class="page-note">Every request is saved as Markdown. This option also approves changes to the files you name; merging still needs human review.</p>
    <template v-if="enabled">
      <label for="local-repository">{{ repositories.length ? 'Assigned repository' : 'Repository directory on the worker machine' }}</label>
      <USelect v-if="repositories.length" id="local-repository" v-model="repository" :items="repositories.map(item => ({ label: item.id, value: item.id }))" placeholder="Select a repository" :aria-describedby="selectedRepository ? 'file-task-checkout' : undefined" class="w-full" />
      <UInput v-else id="local-repository" v-model="repository" required placeholder="/home/you/project" class="w-full" />
      <p v-if="selectedRepository" id="file-task-checkout" class="page-note repository-context">Checkout directory<code>{{ selectedRepository.path }}</code></p>
      <label for="local-paths">Approved files · one relative path per line</label>
      <UTextarea id="local-paths" v-model="paths" required :rows="4" placeholder="src/example.ts" class="w-full" />
      <p class="page-note">These files supply the initial context: up to 32 text files and 48,000 characters total. New files are supported. Granted file tools can also inspect other task-worktree files.</p>
      <div class="implementation-preview" role="status">
        <template v-if="!state.toolAccess"><strong>Implementation access not loaded</strong><p class="page-note">Refresh the worker to inspect saved tool access. The worker confirms available permissions when this request is admitted.</p></template>
        <template v-else-if="implementationEnabled"><strong>Implementation available for Git repositories</strong><p class="page-note">For a Git repository, the saved access lets the worker edit approved files, run the required checks and repair failures. Candidate edits stay in the worker-owned worktree; merging remains a separate review decision.</p><p class="page-note">Required checks: {{ requiredChecks.map(check => check.name).join(', ') }}.</p></template>
        <template v-else><strong>Proposal only</strong><p class="page-note">The worker will save a proposed patch. It will not apply that proposal or verify it automatically.</p><p class="page-note">To enable implementation, {{ !state.toolAccess.builtins.files ? 'allow task-worktree file access' : 'keep file access enabled' }} and {{ requiredChecks.length ? 'keep a required feature check enabled' : 'enable a command preset marked Required feature check' }} in <RouterLink to="/settings#tool-access">Tool access</RouterLink> before creating the request.</p></template>
        <p class="page-note">The request keeps the implementation scope and required checks confirmed at admission.</p>
      </div>
    </template>
  </div>
</template>
<style scoped>
.repository-file-options { display: grid; gap: var(--space-3); min-width: 0; padding-block: var(--space-3) var(--space-5); }
.repository-file-options label { font-size: .875rem; font-weight: 600; }
.repository-file-options p { margin: 0; font-size: .8125rem; line-height: 1.6; }
.repository-file-options .check-label { display: flex; align-items: center; gap: var(--space-3); min-height: 44px; }
.check-label input { width: 20px; height: 20px; flex-shrink: 0; accent-color: var(--ui-primary); }
.implementation-preview { display: grid; gap: var(--space-2); padding-top: var(--space-3); border-top: 1px solid var(--ui-border); }
.implementation-preview strong { font-size: .875rem; color: var(--ui-text-highlighted); }
.implementation-preview a { color: var(--ui-primary); text-underline-offset: 3px; }
.repository-context code { display: block; white-space: normal; overflow-wrap: anywhere; }
.repository-file-options :deep(input), .repository-file-options :deep(button) { min-height: 44px; }
</style>
