<script setup lang="ts">
import { nextTick, ref } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UIcon from '@nuxt/ui/components/Icon.vue';
import { useRepositoryDiscovery } from '../repository-discovery';
const props = defineProps<{ reconsider?: boolean }>();
const { candidate, visible, queued, busy, error, notice, choose: saveChoice } = useRepositoryDiscovery(props.reconsider);
const confirmation = ref<HTMLElement | null>(null);
async function choose(action: 'accept' | 'decline') {
  await saveChoice(action);
  if (notice.value) { await nextTick(); confirmation.value?.focus(); }
}
</script>

<template>
  <section v-if="visible && candidate" class="repository-discovery" aria-labelledby="repository-discovery-title" :aria-busy="busy">
    <div class="discovery-heading"><UIcon name="i-lucide-git-branch" aria-hidden="true" /><h2 id="repository-discovery-title">{{ candidate.decision === 'declined' ? 'Use the repository you skipped?' : 'Use this Git repository?' }}</h2></div>
    <p class="discovery-context">{{ candidate.decision === 'declined' ? 'You chose not to use this checkout. You can change that choice here.' : 'The worker found a repository in its project folder.' }}</p>
    <p class="discovery-path"><code>{{ candidate.path }}</code></p>
    <p class="discovery-meta">{{ candidate.currentBranch ? 'Branch: ' + candidate.currentBranch : 'Detached checkout' }} · {{ candidate.remote ? 'Remote: ' + candidate.remote : 'No remote configured' }}</p>
    <p class="discovery-permission">{{ candidate.watch ? 'Using it enables watching and safe fast-forward pulls. File tasks use separate Git worktrees.' : !candidate.currentBranch ? 'File tasks can use this detached checkout in separate Git worktrees. Watching stays off until you select a branch and enable it in Settings.' : 'Use it for file tasks in separate Git worktrees. Watching stays off until you configure a remote and enable it in Settings.' }}</p>
    <div class="discovery-actions"><UButton type="button" :loading="busy" :disabled="busy || queued" @click="choose('accept')">Use repository</UButton><UButton v-if="candidate.decision === 'pending'" type="button" color="neutral" variant="outline" :disabled="busy" @click="choose('decline')">Don’t use</UButton></div>
    <p v-if="queued" class="discovery-hint">Finish or stop queued and running tasks before adding this repository.</p>
    <p v-else-if="candidate.decision === 'pending'" class="discovery-hint">Your choice is saved. You can change it later in Settings → Repositories.</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
  </section>
  <p v-if="notice" ref="confirmation" class="discovery-notice" role="status" tabindex="-1">{{ notice }}</p>
</template>

<style scoped>
.repository-discovery { padding: var(--space-4); margin-bottom: var(--space-6); border: 1px solid var(--ui-border, #3b4b56); border-radius: 12px; background: #17262f; min-width: 0; overflow-wrap: anywhere; }
.discovery-heading { display: flex; align-items: center; gap: var(--space-2); }
.discovery-heading :deep(.iconify) { flex-shrink: 0; width: 20px; height: 20px; color: #8be0b8; }
.discovery-heading h2 { margin: 0; font-size: 1rem; font-weight: 600; }
.repository-discovery p { margin: var(--space-2) 0 0; line-height: 1.6; font-size: .875rem; }
.repository-discovery .discovery-path { margin-top: var(--space-3); overflow-wrap: anywhere; color: #edf4f7; }
.discovery-path code { font-size: .8125rem; }
.repository-discovery .discovery-meta, .repository-discovery .discovery-hint { color: #b5c4cd; font-size: .8125rem; }
.discovery-permission { max-width: 72ch; color: #d4e1e6; }
.discovery-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-4); }
.discovery-actions :deep(button) { min-height: 44px; }
.discovery-notice { font-size: .875rem; line-height: 1.6; color: #b3f1cf; margin-bottom: var(--space-4); }
</style>
