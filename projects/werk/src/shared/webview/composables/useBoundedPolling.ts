import { onMounted, onUnmounted, unref, type MaybeRef } from "vue";
/** Visibility-aware polling owns one timer and never overlaps its own refresh. */
export function useBoundedPolling(
  refresh: () => void | Promise<unknown>,
  paused: MaybeRef<boolean>,
  intervalMs = 3000,
) {
  let timer: ReturnType<typeof setInterval> | undefined,
    active = false,
    disposed = false;
  const run = async () => {
    if (active || disposed || unref(paused) || document.hidden) return;
    active = true;
    try {
      await refresh();
    } finally {
      active = false;
    }
  };
  const visible = () => {
    if (!document.hidden) void run();
  };
  onMounted(() => {
    timer = setInterval(() => void run(), intervalMs);
    document.addEventListener("visibilitychange", visible);
  });
  onUnmounted(() => {
    disposed = true;
    clearInterval(timer);
    document.removeEventListener("visibilitychange", visible);
  });
  return { refresh: run };
}
