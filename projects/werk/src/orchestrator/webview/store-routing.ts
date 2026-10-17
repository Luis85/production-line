import type { StoreContext, StoreOperations } from './store-context';
import { errorText } from './store-contracts';

/** Routing operations keep their own request and session fences. */
export function createRouting(context: StoreContext, actions: () => StoreOperations) {
  const { state, runtime, now } = context;

  async function checkReadiness() {
    if (!state.token) return;
    const own = runtime.generation,
      id = ++runtime.readinessRead;
    state.readinessBusy = true;
    state.readinessError = "";
    try {
      const overview = await actions().api("/v1/overview");
      if (own === runtime.generation && id === runtime.readinessRead) {
        state.overview = overview;
        state.readinessAt = now();
        actions().applyAccess(overview.access);
      }
    } catch (error) {
      if (own === runtime.generation && id === runtime.readinessRead && !actions().expire(error, own))
        state.readinessError =
          "Bereitschaft konnte nicht geprüft werden. Startterminal prüfen und erneut versuchen.";
    } finally {
      if (id === runtime.readinessRead) state.readinessBusy = false;
    }
  }

  async function loadRouting() {
    if (!state.token || state.routing.busy || state.routing.loaded) return;
    const own = runtime.generation,
      id = ++runtime.routingRead;
    state.routing.busy = true;
    try {
      const [policy, workers] = await Promise.all([
        actions().api("/v1/routing"),
        actions().api("/v1/workers?limit=50"),
      ]);
      if (own === runtime.generation && id === runtime.routingRead)
        Object.assign(state.routing, policy, {
          workerId: policy.workerId ?? "",
          workers: workers.workers,
          loaded: true,
          message: "",
        });
    } catch (error) {
      if (own === runtime.generation && id === runtime.routingRead && !actions().expire(error, own))
        state.routing.message = errorText(error);
    } finally {
      if (id === runtime.routingRead) state.routing.busy = false;
    }
  }

  async function saveRouting() {
    if (
      !state.token ||
      !state.canWrite ||
      state.routing.busy ||
      !state.routing.loaded
    )
      return;
    const own = runtime.generation;
    state.routing.busy = true;
    const body = {
      mode: state.routing.mode,
      workerId:
        state.routing.mode === "manual" ? state.routing.workerId || null : null,
      order: state.routing.order,
    };
    try {
      await actions().api("/v1/routing", body, "PUT");
      if (own === runtime.generation)
        state.routing.message =
          "Routing gespeichert. Bereits vergebene Arbeit bleibt erhalten.";
    } catch (error) {
      if (own === runtime.generation && !actions().expire(error, own))
        state.routing.message = errorText(error);
    } finally {
      if (own === runtime.generation) state.routing.busy = false;
    }
  }

  async function saveTaskRouting() {
    if (
      !state.token ||
      !state.canWrite ||
      state.taskRouting.busy ||
      state.selectedTask?.status !== "queued"
    )
      return;
    const own = runtime.generation,
      taskId = state.selectedTask.id,
      id = ++runtime.routeWrite;
    state.taskRouting.busy = true;
    const valid = () =>
      own === runtime.generation &&
      state.selectedTask?.id === taskId &&
      id === runtime.routeWrite;
    try {
      await actions().api(
        `/v1/tasks/${encodeURIComponent(taskId)}/routing`,
        { workerId: state.taskRouting.workerId.trim() || null },
        "PUT",
      );
      if (valid())
        state.taskRouting.message =
          "Ziel gespeichert. Projekt, Provider und Kapazität bleiben Voraussetzung.";
    } catch (error) {
      if (valid() && !actions().expire(error, own))
        state.taskRouting.message = errorText(error);
    } finally {
      if (valid()) state.taskRouting.busy = false;
    }
  }

  return {
    checkReadiness,
    loadRouting,
    saveRouting,
    saveTaskRouting,
  };
}
