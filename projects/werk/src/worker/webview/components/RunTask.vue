<script setup lang="ts">
import { ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import UTextarea from '@nuxt/ui/components/Textarea.vue';
import { state, workspaceAction } from '../store';
const open = ref(false), title = ref(''), repository = ref(''), paths = ref(''), busy = ref(false), submitted = ref(false);
watch(() => state.unlocked, value => { if (!value) { title.value = ''; repository.value = ''; paths.value = ''; open.value = false; submitted.value = false; } });
async function run() { busy.value = true; try { const result = await workspaceAction('/api/taskboard', { title: title.value, instruction: state.draft, repository: repository.value, paths: paths.value.split('\n').map(item => item.trim()).filter(Boolean) }); if (result) { submitted.value = true; open.value = false; state.draft = ''; } } finally { busy.value = false; } }
</script>
<template>
<div class="run-task"><div class="actions"><UButton color="neutral" variant="outline" icon="i-lucide-play" :disabled="!state.unlocked || !state.chat?.available || !state.draft.trim()" :aria-expanded="open" aria-controls="local-task-form" @click="open = !open; submitted = false">Run task</UButton><span class="muted">Produce a patch from your draft and approved files.</span></div><p v-if="submitted" role="status">File task queued in its own session. <RouterLink to="/history">Open your taskboard →</RouterLink></p><form v-if="open" id="local-task-form" class="settings-form" @submit.prevent="run"><h2>Prepare a local change</h2><p>A new task session uses the selected provider and receives your draft and snapshots of these files. The worker saves a patch for review. Your checkout is not changed, and tests are not run automatically.</p><label for="local-title">Task title</label><UInput id="local-title" v-model="title" required maxlength="200" class="w-full" /><label for="local-repository">Repository directory on the worker machine</label><UInput id="local-repository" v-model="repository" required placeholder="/home/you/project" class="w-full" /><label for="local-paths">Approved files · one relative path per line</label><UTextarea id="local-paths" v-model="paths" required placeholder="src/example.ts" class="w-full" /><p class="page-note">Only these text files are sent to the provider. Up to 32 files and 48,000 characters total. New files are supported.</p><UButton type="submit" :loading="busy" :disabled="!state.draft.trim()">Queue file task</UButton></form></div>
</template>
