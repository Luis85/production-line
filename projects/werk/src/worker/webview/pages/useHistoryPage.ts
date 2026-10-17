import { useRoute } from 'vue-router';
import { computed, nextTick, ref, watch } from 'vue';
import { state, bytes, date, duration, outcome } from '../store';

/** Keeps orchestrator evidence selection and pagination independent from conversations. */
export function useHistoryPage() {
  const route = useRoute();
  const search = ref(''), filter = ref('all'), page = ref(1), selectedId = ref('');
  let inspectTrigger: HTMLElement | null = null;
  async function closeEvidence() {
    selectedId.value = '';
    await nextTick();
    if (inspectTrigger?.isConnected) inspectTrigger.focus();
  }
  async function inspect(pairId: string, event: MouseEvent) {
    if (selectedId.value === pairId) { await closeEvidence(); return; }
    inspectTrigger = event.currentTarget as HTMLElement;
    selectedId.value = pairId;
    await nextTick();
    const heading = document.getElementById('evidence-title');
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: 'start' });
  }
  const options = [{ label: 'All outcomes', value: 'all' }, { label: 'Simulated', value: 'simulated' }, { label: 'Review required', value: 'change-set' }, { label: 'Failed', value: 'failed' }, { label: 'Interrupted', value: 'interrupted' }, { label: 'Running', value: 'running' }, { label: 'Incomplete evidence', value: 'incomplete' }];
  const filtered = computed(() => (state.history?.rows ?? []).filter(row => (filter.value === 'all' || row.outcome === filter.value) && [row.title, row.taskId, row.project, row.profile, row.provenance.featureId].join(' ').toLowerCase().includes(search.value.toLowerCase())));
  const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 25)));
  const visible = computed(() => filtered.value.slice((page.value - 1) * 25, page.value * 25));
  const selected = computed(() => state.history?.rows.find(row => row.pairId === selectedId.value));
  watch([search, filter], () => { page.value = 1; });
  watch(pages, value => { page.value = Math.min(page.value, value); });


  return {
    bytes,
    closeEvidence,
    date,
    duration,
    filter,
    filtered,
    inspect,
    options,
    outcome,
    page,
    pages,
    route,
    search,
    selected,
    selectedId,
    state,
    visible,
  };
}
