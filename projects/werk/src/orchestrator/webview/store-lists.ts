import type { StoreContext, StoreOperations } from './store-context';
import type { Page, RecordData, Tab } from './store-contracts';
import { firstPage, checkedPage, date, errorText, names, targetPage } from './store-contracts';

/** Lists operations keep their own request and session fences. */
export function createLists(context: StoreContext, actions: () => StoreOperations) {
  const { state, runtime, now } = context;

  function pageUrl(path: string, page: Page, limit = 50) {
    return `${path}?limit=${limit}${page.cursor === null ? "" : `&cursor=${encodeURIComponent(page.cursor)}`}`;
  }

  async function refresh({
    reset = false,
    page,
  }: { reset?: boolean; page?: Page } = {}) {
    if (!state.token) return;
    const tab = state.tab,
      own = runtime.generation,
      id = ++runtime.readId;
    const requested =
      page ??
      (reset
        ? firstPage()
        : tab === "workers"
          ? state.workerPage
          : tab === "tasks"
            ? state.taskPage
            : firstPage());
    runtime.readController?.abort();
    const controller = new AbortController();
    runtime.readController = controller;
    state.busy = true;
    try {
      if (tab === "system") {
        const value = await actions().api(
          "/v1/overview",
          undefined,
          "GET",
          controller.signal,
        );
        if (id !== runtime.readId || own !== runtime.generation || tab !== state.tab) return;
        state.overview = value;
        state.readinessAt = now();
        actions().applyAccess(value.access);
      } else if (tab === "metrics") {
        const records: RecordData[] = [];
        let before: string | number | null = null,
          more = false;
        for (let page = 0; page < 10; page++) {
          const result = await actions().api(
            `/v1/snapshots?order=desc&limit=1000${before === null ? "" : `&before=${encodeURIComponent(before)}`}`,
            undefined,
            "GET",
            controller.signal,
          );
          if (
            !Array.isArray(result.snapshots) ||
            result.snapshots.length > 1000
          )
            throw Error("Ungültige Snapshot-Antwort.");
          records.push(...result.snapshots);
          more = result.hasMore ?? result.snapshots.length === 1000;
          if (!more) break;
          if (
            result.nextCursor === null ||
            result.nextCursor === undefined ||
            result.nextCursor === before
          )
            throw Error("Snapshot-Paginierung liefert keinen Fortschritt.");
          before = result.nextCursor;
        }
        if (id !== runtime.readId || own !== runtime.generation || tab !== state.tab) return;
        state.metrics = records.sort((a, b) => a.seq - b.seq);
        state.metricsTruncated = more;
      } else {
        const key = tab === "workers" ? "workers" : "tasks";
        const result = await actions().api(
          pageUrl(`/v1/${key}`, requested),
          undefined,
          "GET",
          controller.signal,
        );
        if (id !== runtime.readId || own !== runtime.generation || tab !== state.tab) return;
        const accepted = checkedPage(result, key, requested);
        if (tab === "tasks") {
          state.tasks = result.tasks;
          state.taskPage = accepted;
          const current = state.tasks.find(
            (task) => task.id === state.selectedTask?.id,
          );
          if (current) state.selectedTask = current;
        } else if (tab === "workers") {
          state.workers = result.workers;
          state.workerPage = accepted;
        } else
          state.intakeSample = {
            count: result.tasks.length,
            imported: result.tasks.filter((t: RecordData) => t.source).length,
            hasMore: result.hasMore,
          };
      }
      state.refreshedAt = now();
      state.stale = false;
      state.sync = `Aktualisiert ${date(now())}`;
    } catch (error) {
      if (
        id !== runtime.readId ||
        own !== runtime.generation ||
        controller.signal.aborted ||
        actions().expire(error, own)
      )
        return;
      state.stale = true;
      state.sync =
        "Aktualisierung fehlgeschlagen · letzter Stand bleibt sichtbar";
      actions().message(
        `${errorText(error)} Die angezeigte Seite bleibt erhalten. Erneut laden.`,
        "error",
      );
    } finally {
      if (id === runtime.readId) {
        state.busy = false;
        runtime.readController = null;
      }
    }
  }

  async function navigate(tab: Tab) {
    if (!Object.hasOwn(names, tab)) return;
    ++runtime.readId;
    runtime.readController?.abort();
    state.busy = false;
    actions().closeWorker();
    ++runtime.detailId;
    runtime.eventController?.abort();
    state.eventBusy = false;
    state.tab = tab;
    await refresh();
  }

  async function movePage(
    kind: "tasks" | "workers",
    direction: "next" | "previous",
  ) {
    const page = kind === "tasks" ? state.taskPage : state.workerPage;
    if (
      !state.token ||
      state.busy ||
      state.tab !== kind ||
      (direction === "next" ? !page.hasMore : !page.previous.length)
    )
      return false;
    const own = runtime.generation;
    await refresh({ page: targetPage(page, direction) });
    return (
      own === runtime.generation &&
      state.tab === kind &&
      (kind === "tasks" ? state.taskPage : state.workerPage) !== page
    );
  }

  function inspectSnapshots(taskId: string) {
    state.selectedSnapshot = null;
    state.metricFilters = {
      project: "",
      worker: "",
      iteration: "",
      outcome: "",
      window: "",
      taskId,
    };
    return navigate("metrics");
  }

  async function poll() {
    if (!state.paused && !state.busy && !state.workerBusy && state.token) {
      if (state.tab === "workers" && state.workerId)
        await actions().showWorker(state.workerId);
      else await refresh();
    }
  }

  return {
    pageUrl,
    refresh,
    navigate,
    movePage,
    inspectSnapshots,
    poll,
  };
}
