import type { StoreContext, StoreOperations } from './store-context';
import type { FactoryOverview } from '../../shared/factory.js';

/** Navigation operations keep their own request and session fences. */
export function createNavigation(context: StoreContext, actions: () => StoreOperations) {
  const { state, runtime } = context;

  function reconcileFactory() {
    if (!state.factories.some((f) => f.id === state.intakeFactory))
      state.intakeFactory = state.scope || state.factories[0]?.id || "";
  }

  async function refresh(registry = true) {
    if (!state.token || state.saving) return;
    const own = runtime.session,
      id = ++runtime.request,
      scope = state.scope;
    runtime.controller?.abort();
    runtime.controller = new AbortController();
    const signal = runtime.controller.signal;
    state.loading = true;
    state.overview = state.cache.get(scope) ?? null;
    state.stale =
      !!state.overview &&
      Date.now() - Date.parse(state.overview.observedAt) > 45000;
    try {
      if (registry) {
        const [factories, lines] = await Promise.all([
          actions().api("/v1/factories", { signal }),
          actions().api("/v1/lines", { signal }),
        ]);
        if (!actions().current(own) || id !== runtime.request) return;
        actions().adoptRegistry(factories);
        state.lines = lines.lines;
        if (scope && !state.factories.some((f) => f.id === scope)) {
          state.scope = "";
          state.lineId = "";
          state.message =
            "Die gewählte Fabrik existiert nicht mehr. Alle Fabriken werden angezeigt.";
          return refresh(false);
        }
        reconcileFactory();
        void actions().loadPolicy();
      }
      const overview = await actions().api<FactoryOverview>(
        "/v1/overview" +
        (scope ? "?factoryId=" + encodeURIComponent(scope) : ""),
        { signal },
      );
      if (!actions().current(own) || id !== runtime.request || scope !== state.scope) return;
      state.cache.set(scope, overview);
      state.overview = overview;
      state.stale = false;
      state.error = "";
      void actions().loadQueue();
    } catch (error) {
      if (!actions().current(own) || id !== runtime.request || signal.aborted) return;
      state.stale = !!state.overview;
      state.error =
        (error as Error).message + " Über „Aktualisieren“ erneut versuchen.";
    } finally {
      if (actions().current(own) && id === runtime.request) {
        state.loading = false;
        runtime.controller = null;
      }
    }
  }

  function navigate(scope: string, lineId = "") {
    if (state.saving || state.intakeBusy || state.policyBusy) return;
    state.scope = scope;
    state.lineId = lineId;
    ++runtime.request;
    runtime.controller?.abort();
    state.overview = state.cache.get(scope) ?? null;
    state.stale = !!state.overview;
    reconcileFactory();
    void refresh(false);
  }

  return {
    reconcileFactory,
    refresh,
    navigate,
  };
}
