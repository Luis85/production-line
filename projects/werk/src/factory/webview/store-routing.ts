import type { StoreContext, StoreOperations } from './store-context';
import type { RoutingPolicy } from './store-contracts';

/** Routing operations keep their own request and session fences. */
export function createRouting(context: StoreContext, actions: () => StoreOperations) {
  const { state, runtime } = context;

  function editPolicy() {
    if (!state.canWrite || state.policyBusy || state.policyLoading) return;
    state.policyDrafts.set(state.intakeFactory, { ...state.policy });
    ++runtime.policyRequest;
  }

  async function loadPolicy() {
    const factory = state.intakeFactory;
    if (!factory || !state.token) return;
    const own = runtime.session,
      id = ++runtime.policyRequest;
    const draft = state.policyDrafts.get(factory);
    if (draft) {
      state.policy = { ...draft };
      state.policyLoading = false;
      return;
    }
    state.policyLoading = true;
    state.policyError = "";
    try {
      const result = await actions().api<RoutingPolicy>(
        "/v1/factories/" + encodeURIComponent(factory) + "/routing",
      );
      if (
        !actions().current(own) ||
        id !== runtime.policyRequest ||
        factory !== state.intakeFactory ||
        state.policyDrafts.has(factory)
      )
        return;
      state.policy = result;
    } catch (error) {
      if (actions().current(own) && id === runtime.policyRequest)
        state.policyError = (error as Error).message;
    } finally {
      if (actions().current(own) && id === runtime.policyRequest) state.policyLoading = false;
    }
  }

  async function savePolicy() {
    if (
      !state.canWrite ||
      state.policyBusy ||
      state.policyLoading ||
      !state.intakeFactory
    )
      return;
    const own = runtime.session,
      factory = state.intakeFactory,
      body = {
        ...state.policy,
        lineId: state.policy.mode === "manual" ? state.policy.lineId : null,
      };
    ++runtime.policyRequest;
    state.policyBusy = true;
    try {
      await actions().api("/v1/factories/" + encodeURIComponent(factory) + "/routing", {
        method: "PUT",
        body,
      });
      if (!actions().current(own)) return;
      state.policyDrafts.delete(factory);
      state.intakeMessage =
        "Factory-Routing gespeichert. Bereits begonnene Lieferungen behalten ihr Ziel.";
    } catch (error) {
      if (actions().current(own)) state.policyError = (error as Error).message;
    } finally {
      if (actions().current(own)) state.policyBusy = false;
    }
  }

  return {
    editPolicy,
    loadPolicy,
    savePolicy,
  };
}
