import { computed, ref, watch } from 'vue';
import { state, workspaceAction } from './store';

/** One consent view; the worker persists the choice across browsers and restarts. */
export function useRepositoryDiscovery(reconsider = false) {
  const busy = ref(false), error = ref(''), notice = ref(''), acknowledged = ref(''), acknowledgedAction = ref('');
  const candidate = computed(() => state.unlocked ? state.environment?.repositories.discovery ?? null : null);
  const visible = computed(() => !!candidate.value && (candidate.value.decision === 'pending' && candidate.value.id !== acknowledged.value || reconsider && candidate.value.decision === 'declined' && !(candidate.value.id === acknowledged.value && acknowledgedAction.value === 'accept')));
  const queued = computed(() => !!state.sessions?.execution.currentSessionId || !!state.sessions?.execution.queued || !!state.status?.activeTasks.length || !!state.status?.queuedTasks?.length);
  let revision = 0;
  watch(() => state.unlocked, unlocked => {
    if (!unlocked) { revision++; busy.value = false; error.value = ''; notice.value = ''; acknowledged.value = ''; acknowledgedAction.value = ''; }
  }, { flush: 'sync' });
  watch(() => candidate.value?.id, () => { error.value = ''; notice.value = ''; });
  async function choose(action: 'accept' | 'decline') {
    const found = candidate.value;
    if (!visible.value || !found || busy.value || action === 'accept' && queued.value) return;
    busy.value = true; error.value = ''; notice.value = '';
    const attempt = ++revision, epoch = state.draftEpoch;
    try {
      const result = await workspaceAction('/api/repositories', { action, discoveryId: found.id });
      if (attempt !== revision || !state.unlocked || state.draftEpoch !== epoch || candidate.value?.id !== found.id) return;
      if (result) {
        acknowledged.value = found.id; acknowledgedAction.value = action;
        notice.value = action === 'accept'
          ? 'Repository added. Select it when preparing a file task; manage it in Settings.'
          : 'Repository skipped. You can use it later from Settings → Repositories.';
      } else error.value = state.actionError || 'Your choice could not be saved. Refresh and try again.';
    } finally { if (attempt === revision) busy.value = false; }
  }
  return { candidate, visible, queued, busy, error, notice, choose };
}
