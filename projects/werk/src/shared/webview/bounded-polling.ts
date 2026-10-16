export interface PollingPorts {
  refresh(signal: AbortSignal): void | Promise<unknown>;
  paused(): boolean;
  hidden(): boolean;
  schedule(callback: () => void): unknown;
  cancel(timer: unknown): void;
}
/** Owns one active-view timer; generations isolate refreshes across deactivation. */
export function createBoundedPoller(ports: PollingPorts) {
  let active = false, disposed = false, busy = false, generation = 0;
  let timer: unknown, controller: AbortController | undefined;
  async function refresh() {
    if (!active || disposed || busy || ports.paused() || ports.hidden()) return;
    const own = generation, current = new AbortController(); controller = current; busy = true;
    try { await ports.refresh(current.signal); }
    finally { if (own === generation) { busy = false; controller = undefined; } }
  }
  const scheduled = () => { void refresh().catch(() => {}); };
  function activate(immediate = true) {
    if (active || disposed) return;
    active = true; timer = ports.schedule(scheduled);
    if (immediate) scheduled();
  }
  function deactivate() {
    if (!active) return;
    active = false; generation++; ports.cancel(timer); timer = undefined;
    controller?.abort(); controller = undefined; busy = false;
  }
  function dispose() { deactivate(); disposed = true; }
  return { refresh, activate, deactivate, dispose };
}
