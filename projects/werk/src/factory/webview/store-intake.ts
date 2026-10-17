import type { StoreContext, StoreOperations } from './store-context';
import type { IntakePage, IntakeRecord } from './store-contracts';

/** Intake operations keep their own request and session fences. */
export function createIntake(context: StoreContext, actions: () => StoreOperations) {
  const { state, runtime } = context;

  async function loadQueue() {
    if (!state.token) return;
    const own = runtime.session,
      id = ++runtime.queueRequest,
      scope = state.scope;
    try {
      const result = await actions().api<IntakePage>(
        "/v1/intake" + (scope ? "?factoryId=" + encodeURIComponent(scope) : ""),
      );
      if (actions().current(own) && id === runtime.queueRequest && scope === state.scope) {
        state.queue = result;
        state.queueError = "";
      }
    } catch (error) {
      if (actions().current(own) && id === runtime.queueRequest)
        state.queueError = (error as Error).message;
    }
  }

  async function submitIntake() {
    if (
      !state.canWrite ||
      !state.token ||
      state.intakeBusy ||
      !state.intakeFactory
    )
      return;
    const own = runtime.session,
      draft = state.taskDraft,
      body = {
        factoryId: state.intakeFactory,
        lineId: draft.lineId || null,
        task: {
          project: draft.project,
          ...(draft.repository.trim() ? { repository: draft.repository.trim() } : {}),
          provider: draft.execution === "cli" ? "codex" : draft.provider,
          executionMode: draft.execution,
          priority: 1,
          ...(draft.reference.trim()
            ? { requirementRef: draft.reference.trim() }
            : {
              title: draft.title,
              criteria: draft.criteria
                .split("\n")
                .map((v) => v.trim())
                .filter(Boolean),
              wikilinks: [],
            }),
        },
      };
    state.intakeBusy = true;
    try {
      const result = await actions().api("/v1/intake", {
        method: "POST",
        body,
        key: actions().key(runtime.intakeIntent, "POST", "/v1/intake", body),
      });
      if (!actions().current(own)) return;
      state.intakeMessage = "Gespeichert: " + result.id + " · " + result.reason;
      draft.title = draft.criteria = draft.reference = "";
      delete runtime.intakeIntent.signature;
      delete runtime.intakeIntent.key;
      await loadQueue();
    } catch (error) {
      if (actions().current(own))
        state.intakeMessage =
          (error as Error).message +
          " Deine Eingaben bleiben erhalten. Prüfe die Verbindung und versuche es erneut.";
    } finally {
      if (actions().current(own)) state.intakeBusy = false;
    }
  }

  async function assignTarget(item: IntakeRecord) {
    if (!state.canWrite || state.routingBusy.has(item.id)) return;
    const own = runtime.session;
    state.routingBusy.add(item.id);
    try {
      await actions().api("/v1/intake/" + encodeURIComponent(item.id) + "/routing", {
        method: "PUT",
        body: {
          lineId: (state.queueTargets.get(item.id) ?? item.lineId) || null,
        },
      });
      if (actions().current(own)) await loadQueue();
    } catch (error) {
      if (actions().current(own)) state.intakeMessage = (error as Error).message;
    } finally {
      if (actions().current(own)) state.routingBusy.delete(item.id);
    }
  }

  return {
    loadQueue,
    submitIntake,
    assignTarget,
  };
}
