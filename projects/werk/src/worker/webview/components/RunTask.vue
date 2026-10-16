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
</script>
<template>
  <div class="repository-file-options">
    <label class="check-label" for="request-file-changes"><input id="request-file-changes" v-model="enabled" type="checkbox" />Allow changes to approved repository files</label>
    <p class="page-note">Every request is saved as Markdown. This option additionally permits a review patch for the files you name.</p>
    <template v-if="enabled">
      <label for="local-repository">{{ repositories.length ? 'Assigned repository' : 'Repository directory on the worker machine' }}</label>
      <USelect v-if="repositories.length" id="local-repository" v-model="repository" :items="repositories.map(item => ({ label: item.id, value: item.id }))" placeholder="Select a repository" :aria-describedby="selectedRepository ? 'file-task-checkout' : undefined" class="w-full" />
      <UInput v-else id="local-repository" v-model="repository" required placeholder="/home/you/project" class="w-full" />
      <p v-if="selectedRepository" id="file-task-checkout" class="page-note repository-context">Checkout directory<code>{{ selectedRepository.path }}</code></p>
      <label for="local-paths">Approved files · one relative path per line</label>
      <UTextarea id="local-paths" v-model="paths" required :rows="4" placeholder="src/example.ts" class="w-full" />
      <p class="page-note">Only these text files are sent as file context: up to 32 files and 48,000 characters total. New files are supported. Assigned repositories use an isolated Git worktree.</p>
      <p class="page-note">The worker saves a patch for review. It does not apply the patch or run tests automatically.</p>
    </template>
  </div>
</template>
<style scoped>
.repository-file-options { display: grid; gap: var(--space-3); min-width: 0; padding-block: var(--space-3) var(--space-5); }
.repository-file-options label { font-size: .875rem; font-weight: 600; }
.repository-file-options p { margin: 0; font-size: .8125rem; line-height: 1.6; }
.repository-file-options .check-label { display: flex; align-items: center; gap: var(--space-3); min-height: 44px; }
.check-label input { width: 20px; height: 20px; flex-shrink: 0; accent-color: var(--ui-primary); }
.repository-context code { display: block; white-space: normal; overflow-wrap: anywhere; }
.repository-file-options :deep(input), .repository-file-options :deep(button) { min-height: 44px; }
</style>
