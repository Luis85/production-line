import type { StoreContext, StoreOperations } from './store-context';
import type { RecordData } from './store-contracts';
import { firstPage, errorText } from './store-contracts';

/** Intake operations keep their own request and session fences. */
export function createIntake(context: StoreContext, actions: () => StoreOperations) {
  const { state, runtime, uuid } = context;

  function intakePayload() {
    const draft = state.intake,
      manual = draft.executionMode === "cli" || draft.mode === "manual";
    const body: RecordData = manual
      ? {
        project: draft.project.trim(),
        title: draft.title.trim(),
        criteria: draft.criteria
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        wikilinks: draft.wikilinks
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      }
      : {
        project: draft.project.trim(),
        requirementRef: draft.requirementRef.trim(),
      };
    if (draft.repository.trim()) body.repository = draft.repository.trim();
    if (draft.provider !== "auto") body.provider = draft.provider;
    if (draft.executionMode === "cli") {
      body.executionMode = "cli";
      body.provider = "codex";
    }
    if (Number(draft.priority) !== 1) body.priority = Number(draft.priority);
    return body;
  }

  async function submitTask() {
    if (state.submitting) return;
    if (!state.token || !state.canWrite) {
      actions().message(
        "Für neue Aufträge mit einem Operator- oder Administrationstoken verbinden.",
        "error",
      );
      return;
    }
    const body = intakePayload();
    if (
      !/^[a-zA-Z0-9_-]{1,100}$/.test(body.project) ||
      (body.title !== undefined
        ? !body.title || !body.criteria.length
        : !body.requirementRef)
    ) {
      actions().message(
        "Projekt, Feature und Akzeptanzkriterien oder einen Vault-Verweis ergänzen.",
        "error",
      );
      return;
    }
    const encoded = JSON.stringify(body);
    if (runtime.lastBody !== encoded) {
      runtime.lastBody = encoded;
      runtime.retryKey = uuid();
    }
    const own = runtime.generation;
    state.submitting = true;
    try {
      const task = await actions().api("/v1/tasks", body, "POST", undefined, runtime.retryKey);
      if (own !== runtime.generation) return;
      state.intake.title = "";
      state.intake.criteria = "";
      state.intake.wikilinks = "";
      state.intake.requirementRef = "";
      runtime.lastBody = "";
      runtime.retryKey = "";
      state.taskSearch = "";
      state.taskStatus = "";
      state.taskPage = firstPage();
      actions().closeTask();
      state.tab = "tasks";
      actions().message(`Gespeichert: ${task.id}`, "success");
      await Promise.all([actions().refresh(), actions().showTask(task)]);
      return task;
    } catch (error) {
      if (own === runtime.generation)
        actions().message(
          `${errorText(error)} Eingaben bleiben erhalten. Unverändert erneut senden verwendet denselben Idempotenzschlüssel.`,
          "error",
        );
    } finally {
      if (own === runtime.generation) state.submitting = false;
    }
  }

  return {
    intakePayload,
    submitTask,
  };
}
