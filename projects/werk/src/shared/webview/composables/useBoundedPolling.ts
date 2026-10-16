import { onActivated, onDeactivated, onMounted, onUnmounted, unref, type MaybeRef } from 'vue';
import { createBoundedPoller } from '../bounded-polling';
/** Visibility-aware polling suspends cached pages; consumers fence or abort stale response adoption. */
export function useBoundedPolling(refresh: (signal: AbortSignal) => void | Promise<unknown>, paused: MaybeRef<boolean>, intervalMs = 3000) {
  const polling = createBoundedPoller({ refresh, paused: () => unref(paused), hidden: () => document.hidden,
    schedule: callback => setInterval(callback, intervalMs), cancel: timer => clearInterval(timer as ReturnType<typeof setInterval>), });
  const visible = () => { if (!document.hidden) void polling.refresh().catch(() => {}); };
  onMounted(() => { polling.activate(false); document.addEventListener('visibilitychange', visible); });
  onActivated(() => polling.activate());
  onDeactivated(polling.deactivate);
  onUnmounted(() => { polling.dispose(); document.removeEventListener('visibilitychange', visible); });
  return { refresh: polling.refresh };
}
