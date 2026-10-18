import { onActivated, onDeactivated, onMounted, onUnmounted, ref, shallowRef, watch, type WatchSource } from 'vue';
import { state } from './store';

/** Freshness keeps aging while browser network updates are paused. */
export function useWorkerClock() {
  const now = ref(Date.now());
  let active = false, disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  function stop() {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  }
  function start() {
    now.value = Date.now();
    if (!disposed && active && state.unlocked && timer === undefined)
      timer = setInterval(() => { now.value = Date.now(); }, 1000);
  }
  const activate = () => { if (!disposed) { active = true; start(); } };
  const deactivate = () => { active = false; stop(); };
  onMounted(activate);
  onActivated(activate);
  onDeactivated(deactivate);
  onUnmounted(() => { disposed = true; deactivate(); });
  watch(() => state.unlocked, unlocked => { if (unlocked) start(); else stop(); }, { flush: 'sync' });
  return now;
}

/** Authenticated page reads share quiet polling, query identity and access lifetime fences. */
export function useWorkerSnapshot<T>(read: () => Promise<T>, sources: WatchSource[] = []) {
  const data = shallowRef<T | null>(null), error = ref(''), readAt = ref('');
  const loading = ref(false), refreshing = ref(false), now = useWorkerClock();
  let active = false, disposed = false, revision = 0;

  function invalidate(clear = false) {
    revision++;
    loading.value = false;
    refreshing.value = false;
    if (clear) { data.value = null; error.value = ''; readAt.value = ''; }
  }
  async function load(manual = false) {
    if (!active || disposed || !state.unlocked || refreshing.value || !manual && loading.value) return;
    const current = ++revision;
    const canAdopt = () => current === revision && active && !disposed && state.unlocked;
    loading.value = true;
    refreshing.value = manual;
    try {
      const result = await read();
      if (!canAdopt()) return;
      now.value = Date.now();
      data.value = result;
      readAt.value = new Date(now.value).toISOString();
      error.value = '';
    } catch (failure) {
      if (canAdopt()) error.value = failure instanceof Error ? failure.message : 'Worker measurements could not be refreshed.';
    } finally {
      if (current === revision) { loading.value = false; refreshing.value = false; }
    }
  }
  function activate() {
    if (disposed || active) return;
    active = true;
    void load();
  }
  function deactivate() {
    active = false;
    invalidate();
  }
  onMounted(activate);
  onActivated(activate);
  onDeactivated(deactivate);
  onUnmounted(() => { disposed = true; deactivate(); invalidate(true); });
  watch(() => state.unlocked, unlocked => {
    invalidate(true);
    if (unlocked) void load();
  }, { flush: 'sync' });
  watch(() => state.refreshRevision, () => { void load(); });
  if (sources.length) watch(sources, () => { invalidate(true); void load(); }, { flush: 'sync' });
  return { data, error, loading, refreshing, readAt, now, refresh: () => load(true) };
}
