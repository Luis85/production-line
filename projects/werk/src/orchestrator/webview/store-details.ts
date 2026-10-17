import type { StoreContext, StoreOperations } from './store-context';
import { firstPage, targetPage, checkedPage, errorText, checkedWorkerDetail } from './store-contracts';
import type { RecordData } from './store-contracts';

/** Details operations keep their own request and session fences. */
export function createDetails(context: StoreContext, actions: () => StoreOperations) {
  const { runtime, state } = context;

  function closeTask() {
    ++runtime.detailId;
    ++runtime.routeWrite;
    runtime.eventController?.abort();
    runtime.eventController = null;
    state.selectedTask = null;
    state.events = [];
    state.eventPage = firstPage();
    state.eventBusy = false;
    state.eventError = "";
    state.taskRouting = { workerId: "", busy: false, message: "" };
  }

  function closeWorker() {
    ++runtime.workerRead;
    runtime.workerController?.abort();
    runtime.workerController = null;
    state.workerId = "";
    state.workerDetail = null;
    state.workerBusy = false;
    state.workerError = "";
  }

  async function loadEvents(direction?: "next" | "previous") {
    const task = state.selectedTask;
    if (
      !task ||
      !state.token ||
      state.tab !== "tasks" ||
      (direction &&
        (state.eventBusy ||
          (direction === "next"
            ? !state.eventPage.hasMore
            : !state.eventPage.previous.length)))
    )
      return;
    const page = direction
      ? targetPage(state.eventPage, direction)
      : firstPage(),
      own = runtime.generation,
      id = ++runtime.detailId;
    runtime.eventController?.abort();
    const controller = new AbortController();
    runtime.eventController = controller;
    state.eventBusy = true;
    state.eventError = "";
    try {
      const result = await actions().api(
        actions().pageUrl(`/v1/tasks/${encodeURIComponent(task.id)}/events`, page, 200),
        undefined,
        "GET",
        controller.signal,
      );
      if (
        own !== runtime.generation ||
        id !== runtime.detailId ||
        state.tab !== "tasks" ||
        task.id !== state.selectedTask?.id
      )
        return;
      state.eventPage = checkedPage(result, "events", page, 200);
      state.events = result.events;
    } catch (error) {
      if (
        own === runtime.generation &&
        id === runtime.detailId &&
        !controller.signal.aborted &&
        !actions().expire(error, own)
      )
        state.eventError = `${errorText(error)} Die bisherige Ereignisseite bleibt erhalten.`;
    } finally {
      if (id === runtime.detailId) {
        state.eventBusy = false;
        runtime.eventController = null;
      }
    }
  }

  async function showTask(task: RecordData) {
    if (!state.token || state.tab !== "tasks") return;
    if (state.selectedTask?.id !== task.id) {
      closeTask();
      state.taskRouting = { workerId: "", busy: false, message: "" };
    }
    state.selectedTask = task;
    await loadEvents();
  }

  async function showTaskId(id: string) {
    if (!state.token || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return;
    const own = runtime.generation;
    state.tab = "tasks";
    closeWorker();
    closeTask();
    state.taskSearch = "";
    state.taskStatus = "";
    const selection = runtime.detailId;
    try {
      const task = await actions().api(`/v1/tasks/${encodeURIComponent(id)}`);
      if (own === runtime.generation && selection === runtime.detailId && state.tab === "tasks")
        await showTask(task);
    } catch (error) {
      if (
        own === runtime.generation &&
        selection === runtime.detailId &&
        state.tab === "tasks" &&
        !actions().expire(error, own)
      )
        actions().message(
          "Der verlinkte Auftrag ist nicht verfügbar. Prüfe die Linienadresse.",
          "error",
        );
    }
  }

  async function showWorker(id: string) {
    if (!state.token || state.tab !== "workers") return;
    if (id !== state.workerId) closeWorker();
    state.workerId = id;
    const own = runtime.generation,
      read = ++runtime.workerRead;
    runtime.workerController?.abort();
    const controller = new AbortController();
    runtime.workerController = controller;
    state.workerBusy = true;
    state.workerError = "";
    try {
      const value = checkedWorkerDetail(
        await actions().api(
          `/v1/workers/${encodeURIComponent(id)}`,
          undefined,
          "GET",
          controller.signal,
        ),
        id,
      );
      if (own === runtime.generation && read === runtime.workerRead && state.tab === "workers")
        state.workerDetail = value;
    } catch (error) {
      if (
        own === runtime.generation &&
        read === runtime.workerRead &&
        !controller.signal.aborted &&
        !actions().expire(error, own)
      )
        state.workerError = `${state.workerDetail ? "Veralteter letzter Stand. " : ""}${errorText(error)} Details erneut laden oder zur Liste zurückkehren.`;
    } finally {
      if (read === runtime.workerRead) {
        state.workerBusy = false;
        runtime.workerController = null;
      }
    }
  }

  return {
    closeTask,
    closeWorker,
    loadEvents,
    showTask,
    showTaskId,
    showWorker,
  };
}
