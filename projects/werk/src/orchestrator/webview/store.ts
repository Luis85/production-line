/** Memory-only authenticated state. Transport injection keeps race contracts testable. */
export type Tab = "system" | "intake" | "tasks" | "workers" | "metrics";
export type RecordData = Record<string, any>;
export interface Page {
  cursor: string | null;
  previous: (string | null)[];
  nextCursor: string | null;
  hasMore: boolean;
  loaded: boolean;
  count: number;
}
export const firstPage = (): Page => ({
  cursor: null,
  previous: [],
  nextCursor: null,
  hasMore: false,
  loaded: false,
  count: 0,
});
export const names: Record<Tab, string> = {
  system: "Dashboard",
  intake: "Auftrag übergeben",
  tasks: "Aufträge",
  workers: "Worker",
  metrics: "Messwerte",
};
export const statuses: Record<string, string> = {
  queued: "Wartet",
  running: "In Ausführung",
  review: "Review erforderlich",
  simulated: "Simuliert",
  blocked: "Klärung erforderlich",
};
export const date = (value: string | number) =>
  Number.isFinite(new Date(value).getTime())
    ? new Date(value).toLocaleString("de-DE")
    : "Nicht erfasst";
export const contextState = (task: RecordData) =>
  task.context?.commit
    ? `Kontext am Commit ${task.context.commit} fixiert · ${task.executionMode === "cli" ? "CLI-Ausführung zum Review" : "Ausführung weiterhin simuliert"}`
    : "Kontext noch nicht aufgelöst";
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Anfrage fehlgeschlagen.";
export function checkedPage(
  result: RecordData,
  key: string,
  page: Page,
  limit = 50,
): Page {
  if (
    !result ||
    !Array.isArray(result[key]) ||
    result[key].length > limit ||
    typeof result.hasMore !== "boolean" ||
    (result.hasMore
      ? typeof result.nextCursor !== "string" ||
        !result.nextCursor ||
        result.nextCursor.length > 1024 ||
        result.nextCursor === page.cursor ||
        !result[key].length
      : result.nextCursor !== null)
  )
    throw Error("Ungültige Seitenantwort. Bitte erneut laden.");
  if (
    result[key].some(
      (item: RecordData) =>
        !item ||
        (key === "events"
          ? !Number.isSafeInteger(item.seq)
          : typeof item.id !== "string") ||
        (key === "tasks" && typeof item.title !== "string") ||
        (key === "workers" && !Array.isArray(item.profiles)),
    )
  )
    throw Error("Ungültige Datensätze auf dieser Seite.");
  return {
    ...page,
    previous: [...page.previous],
    nextCursor: result.nextCursor,
    hasMore: result.hasMore,
    loaded: true,
    count: result[key].length,
  };
}
function targetPage(page: Page, direction: "next" | "previous"): Page {
  return direction === "next"
    ? {
        ...firstPage(),
        cursor: page.nextCursor,
        previous: [...page.previous, page.cursor],
      }
    : {
        ...firstPage(),
        cursor: page.previous.at(-1) ?? null,
        previous: page.previous.slice(0, -1),
      };
}
export function checkedWorkerDetail(value: RecordData, id: string) {
  const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
  const time = (v: unknown) =>
    typeof v === "number" &&
    Number.isFinite(v) &&
    Number.isFinite(new Date(v).getTime());
  if (
    !value ||
    value.id !== id ||
    typeof value.project !== "string" ||
    !time(value.seen) ||
    typeof value.online !== "boolean" ||
    !value.config ||
    !integer(value.config.maxParallel) ||
    !integer(value.config.maxAttempts) ||
    !["priority", "fifo"].includes(value.config.order) ||
    !Array.isArray(value.profiles) ||
    value.profiles.length > 8 ||
    value.profiles.some(
      (p: RecordData) =>
        !p ||
        typeof p.id !== "string" ||
        !["claude", "codex"].includes(p.provider) ||
        !["mock", "cli"].includes(p.mode) ||
        !integer(p.maxParallel),
    ) ||
    !Array.isArray(value.activeTasks) ||
    value.activeTasks.length > 8 ||
    typeof value.activeTasksTruncated !== "boolean" ||
    value.activeTasks.some(
      (t: RecordData) =>
        !t ||
        typeof t.id !== "string" ||
        t.status !== "running" ||
        !integer(t.attempt) ||
        (t.profile !== null && typeof t.profile !== "string") ||
        (t.expiresAt !== null && !time(t.expiresAt)),
    )
  )
    throw Error("Ungültige Worker-Antwort. Bitte erneut laden.");
  return value;
}
export interface StoreOptions {
  request?: (path: string, init: RequestInit) => Promise<any>;
  now?: () => number;
  uuid?: () => string;
  reactive?: <T extends object>(value: T) => T;
}
export function createOrchestratorStore(options: StoreOptions = {}) {
  const now = options.now ?? Date.now;
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const request =
    options.request ??
    (async (path, init) => {
      const response = await fetch(path, init);
      let value: any;
      try {
        value = await response.json();
      } catch {
        throw Object.assign(
          Error(`Keine lesbare JSON-Antwort (HTTP ${response.status}).`),
          { status: response.status },
        );
      }
      if (!response.ok)
        throw Object.assign(Error(value?.error || `HTTP ${response.status}`), {
          status: response.status,
        });
      return value;
    });
  const state = (options.reactive ?? ((value) => value))({
    token: "",
    canWrite: false,
    role: "",
    tab: "system" as Tab,
    connecting: false,
    submitting: false,
    busy: false,
    paused: false,
    message: "",
    messageKind: "info",
    sync: "Noch nicht verbunden",
    refreshedAt: null as number | null,
    stale: false,
    overview: null as RecordData | null,
    readinessAt: null as number | null,
    readinessBusy: false,
    readinessError: "",
    tasks: [] as RecordData[],
    workers: [] as RecordData[],
    taskPage: firstPage(),
    workerPage: firstPage(),
    eventPage: firstPage(),
    selectedTask: null as RecordData | null,
    events: [] as RecordData[],
    eventBusy: false,
    eventError: "",
    workerId: "",
    workerDetail: null as RecordData | null,
    workerBusy: false,
    workerError: "",
    taskSearch: "",
    taskStatus: "",
    showEmptyStatuses: false,
    metrics: [] as RecordData[],
    metricsTruncated: false,
    selectedSnapshot: null as RecordData | null,
    metricFilters: {
      project: "",
      worker: "",
      iteration: "",
      outcome: "",
      window: "",
      taskId: "",
    },
    intake: {
      project: "demo",
      repository: "",
      projectEdited: false,
      mode: "vault",
      executionMode: "mock",
      provider: "auto",
      priority: "1",
      title: "",
      criteria: "",
      wikilinks: "",
      requirementRef: "",
    },
    intakeSample: null as {
      count: number;
      imported: number;
      hasMore: boolean;
    } | null,
    routing: {
      mode: "auto",
      workerId: "",
      order: "worker",
      workers: [] as RecordData[],
      busy: false,
      loaded: false,
      message: "",
    },
    taskRouting: { workerId: "", busy: false, message: "" },
    interactionOpen: false,
    tourOpen: false,
  });
  let generation = 0,
    connectId = 0,
    readId = 0,
    detailId = 0,
    workerRead = 0,
    routingRead = 0,
    routeWrite = 0,
    readinessRead = 0;
  let readController: AbortController | null = null,
    eventController: AbortController | null = null,
    workerController: AbortController | null = null;
  let lastBody = "",
    retryKey = "";
  function message(text: string, kind = "info") {
    state.message = text;
    state.messageKind = kind;
  }
  async function api(
    path: string,
    body?: RecordData,
    method = "GET",
    signal?: AbortSignal,
    key?: string,
    credential = state.token,
  ) {
    return request(path, {
      method,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${credential}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    });
  }
  function applyAccess(access: any) {
    state.canWrite =
      access === undefined ||
      (access?.permissions?.write === true &&
        ["admin", "operator"].includes(access?.principal?.role));
    state.role = state.canWrite
      ? access?.principal?.role === "operator"
        ? "Operator"
        : "Administration"
      : "Nur Lesezugriff";
  }
  function closeTask() {
    ++detailId;
    ++routeWrite;
    eventController?.abort();
    eventController = null;
    state.selectedTask = null;
    state.events = [];
    state.eventPage = firstPage();
    state.eventBusy = false;
    state.eventError = "";
    state.taskRouting = { workerId: "", busy: false, message: "" };
  }
  function closeWorker() {
    ++workerRead;
    workerController?.abort();
    workerController = null;
    state.workerId = "";
    state.workerDetail = null;
    state.workerBusy = false;
    state.workerError = "";
  }
  function clearSession(expired = false) {
    ++generation;
    ++readId;
    ++routingRead;
    ++readinessRead;
    readController?.abort();
    readController = null;
    closeTask();
    closeWorker();
    state.token = "";
    state.canWrite = false;
    state.role = "";
    state.busy = false;
    state.tasks = [];
    state.workers = [];
    state.metrics = [];
    state.overview = null;
    state.taskPage = firstPage();
    state.workerPage = firstPage();
    state.taskSearch = "";
    state.taskStatus = "";
    state.selectedSnapshot = null;
    state.metricFilters = {
      project: "",
      worker: "",
      iteration: "",
      outcome: "",
      window: "",
      taskId: "",
    };
    state.metricsTruncated = false;
    state.readinessAt = null;
    state.readinessError = "";
    state.readinessBusy = false;
    state.intakeSample = null;
    state.routing = {
      mode: "auto",
      workerId: "",
      order: "worker",
      workers: [],
      busy: false,
      loaded: false,
      message: "",
    };
    state.interactionOpen = false;
    state.tourOpen = false;
    state.sync = "Noch nicht verbunden";
    state.refreshedAt = null;
    state.stale = false;
    if (expired)
      message(
        "Zugangstoken nicht mehr gültig. Bitte erneut verbinden; ungespeicherte Intake-Eingaben bleiben erhalten.",
        "error",
      );
  }
  function expire(error: any, own: number) {
    if (
      own === generation &&
      error?.status === 401 &&
      state.token &&
      !state.submitting
    ) {
      clearSession(true);
      return true;
    }
    return false;
  }
  async function connect(candidate: string) {
    if (state.submitting || state.connecting) return;
    if (!candidate.trim()) {
      message("Bitte ein Zugangstoken eingeben.", "error");
      return;
    }
    const id = ++connectId;
    state.connecting = true;
    clearSession();
    try {
      const overview = await api(
        "/v1/overview",
        undefined,
        "GET",
        undefined,
        undefined,
        candidate.trim(),
      );
      if (id !== connectId) return;
      state.token = candidate.trim();
      state.overview = overview;
      state.readinessAt = now();
      applyAccess(overview.access);
      if (
        /^[a-zA-Z0-9_-]{1,100}$/.test(overview.project ?? "") &&
        !state.intake.projectEdited &&
        ["", "demo"].includes(state.intake.project)
      )
        state.intake.project = overview.project;
      message(
        "Verbunden. Aufträge werden im Orchestrator gespeichert.",
        "success",
      );
    } catch (error) {
      if (id === connectId)
        message(
          (error as any)?.status === 401
            ? "Token nicht akzeptiert. WERK_ADMIN_TOKEN dieser Linie prüfen."
            : "Verbindung nicht möglich. Prüfe Startterminal und Linienadresse und versuche erneut.",
          "error",
        );
    } finally {
      if (id === connectId) state.connecting = false;
    }
  }
  function disconnect() {
    if (state.submitting) return;
    ++connectId;
    state.connecting = false;
    clearSession();
    message(
      "Verbindung getrennt. Das Token wurde aus dem Seitenzustand entfernt.",
    );
  }
  function pageUrl(path: string, page: Page, limit = 50) {
    return `${path}?limit=${limit}${page.cursor === null ? "" : `&cursor=${encodeURIComponent(page.cursor)}`}`;
  }
  async function refresh({
    reset = false,
    page,
  }: { reset?: boolean; page?: Page } = {}) {
    if (!state.token) return;
    const tab = state.tab,
      own = generation,
      id = ++readId;
    const requested =
      page ??
      (reset
        ? firstPage()
        : tab === "workers"
          ? state.workerPage
          : tab === "tasks"
            ? state.taskPage
            : firstPage());
    readController?.abort();
    const controller = new AbortController();
    readController = controller;
    state.busy = true;
    try {
      if (tab === "system") {
        const value = await api(
          "/v1/overview",
          undefined,
          "GET",
          controller.signal,
        );
        if (id !== readId || own !== generation || tab !== state.tab) return;
        state.overview = value;
        state.readinessAt = now();
        applyAccess(value.access);
      } else if (tab === "metrics") {
        const records: RecordData[] = [];
        let before: string | number | null = null,
          more = false;
        for (let page = 0; page < 10; page++) {
          const result = await api(
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
        if (id !== readId || own !== generation || tab !== state.tab) return;
        state.metrics = records.sort((a, b) => a.seq - b.seq);
        state.metricsTruncated = more;
      } else {
        const key = tab === "workers" ? "workers" : "tasks";
        const result = await api(
          pageUrl(`/v1/${key}`, requested),
          undefined,
          "GET",
          controller.signal,
        );
        if (id !== readId || own !== generation || tab !== state.tab) return;
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
        id !== readId ||
        own !== generation ||
        controller.signal.aborted ||
        expire(error, own)
      )
        return;
      state.stale = true;
      state.sync =
        "Aktualisierung fehlgeschlagen · letzter Stand bleibt sichtbar";
      message(
        `${errorText(error)} Die angezeigte Seite bleibt erhalten. Erneut laden.`,
        "error",
      );
    } finally {
      if (id === readId) {
        state.busy = false;
        readController = null;
      }
    }
  }
  async function navigate(tab: Tab) {
    if (!Object.hasOwn(names, tab)) return;
    ++readId;
    readController?.abort();
    state.busy = false;
    closeWorker();
    ++detailId;
    eventController?.abort();
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
    const own = generation;
    await refresh({ page: targetPage(page, direction) });
    return (
      own === generation &&
      state.tab === kind &&
      (kind === "tasks" ? state.taskPage : state.workerPage) !== page
    );
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
      own = generation,
      id = ++detailId;
    eventController?.abort();
    const controller = new AbortController();
    eventController = controller;
    state.eventBusy = true;
    state.eventError = "";
    try {
      const result = await api(
        pageUrl(`/v1/tasks/${encodeURIComponent(task.id)}/events`, page, 200),
        undefined,
        "GET",
        controller.signal,
      );
      if (
        own !== generation ||
        id !== detailId ||
        state.tab !== "tasks" ||
        task.id !== state.selectedTask?.id
      )
        return;
      state.eventPage = checkedPage(result, "events", page, 200);
      state.events = result.events;
    } catch (error) {
      if (
        own === generation &&
        id === detailId &&
        !controller.signal.aborted &&
        !expire(error, own)
      )
        state.eventError = `${errorText(error)} Die bisherige Ereignisseite bleibt erhalten.`;
    } finally {
      if (id === detailId) {
        state.eventBusy = false;
        eventController = null;
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
    const own = generation;
    state.tab = "tasks";
    closeWorker();
    closeTask();
    state.taskSearch = "";
    state.taskStatus = "";
    const selection = detailId;
    try {
      const task = await api(`/v1/tasks/${encodeURIComponent(id)}`);
      if (own === generation && selection === detailId && state.tab === "tasks")
        await showTask(task);
    } catch (error) {
      if (
        own === generation &&
        selection === detailId &&
        state.tab === "tasks" &&
        !expire(error, own)
      )
        message(
          "Der verlinkte Auftrag ist nicht verfügbar. Prüfe die Linienadresse.",
          "error",
        );
    }
  }
  async function showWorker(id: string) {
    if (!state.token || state.tab !== "workers") return;
    if (id !== state.workerId) closeWorker();
    state.workerId = id;
    const own = generation,
      read = ++workerRead;
    workerController?.abort();
    const controller = new AbortController();
    workerController = controller;
    state.workerBusy = true;
    state.workerError = "";
    try {
      const value = checkedWorkerDetail(
        await api(
          `/v1/workers/${encodeURIComponent(id)}`,
          undefined,
          "GET",
          controller.signal,
        ),
        id,
      );
      if (own === generation && read === workerRead && state.tab === "workers")
        state.workerDetail = value;
    } catch (error) {
      if (
        own === generation &&
        read === workerRead &&
        !controller.signal.aborted &&
        !expire(error, own)
      )
        state.workerError = `${state.workerDetail ? "Veralteter letzter Stand. " : ""}${errorText(error)} Details erneut laden oder zur Liste zurückkehren.`;
    } finally {
      if (read === workerRead) {
        state.workerBusy = false;
        workerController = null;
      }
    }
  }
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
      message(
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
      message(
        "Projekt, Feature und Akzeptanzkriterien oder einen Vault-Verweis ergänzen.",
        "error",
      );
      return;
    }
    const encoded = JSON.stringify(body);
    if (lastBody !== encoded) {
      lastBody = encoded;
      retryKey = uuid();
    }
    const own = generation;
    state.submitting = true;
    try {
      const task = await api("/v1/tasks", body, "POST", undefined, retryKey);
      if (own !== generation) return;
      state.intake.title = "";
      state.intake.criteria = "";
      state.intake.wikilinks = "";
      state.intake.requirementRef = "";
      lastBody = "";
      retryKey = "";
      state.taskSearch = "";
      state.taskStatus = "";
      state.taskPage = firstPage();
      closeTask();
      state.tab = "tasks";
      message(`Gespeichert: ${task.id}`, "success");
      await Promise.all([refresh(), showTask(task)]);
      return task;
    } catch (error) {
      if (own === generation)
        message(
          `${errorText(error)} Eingaben bleiben erhalten. Unverändert erneut senden verwendet denselben Idempotenzschlüssel.`,
          "error",
        );
    } finally {
      if (own === generation) state.submitting = false;
    }
  }
  async function checkReadiness() {
    if (!state.token) return;
    const own = generation,
      id = ++readinessRead;
    state.readinessBusy = true;
    state.readinessError = "";
    try {
      const overview = await api("/v1/overview");
      if (own === generation && id === readinessRead) {
        state.overview = overview;
        state.readinessAt = now();
        applyAccess(overview.access);
      }
    } catch (error) {
      if (own === generation && id === readinessRead && !expire(error, own))
        state.readinessError =
          "Bereitschaft konnte nicht geprüft werden. Startterminal prüfen und erneut versuchen.";
    } finally {
      if (id === readinessRead) state.readinessBusy = false;
    }
  }
  async function loadRouting() {
    if (!state.token || state.routing.busy || state.routing.loaded) return;
    const own = generation,
      id = ++routingRead;
    state.routing.busy = true;
    try {
      const [policy, workers] = await Promise.all([
        api("/v1/routing"),
        api("/v1/workers?limit=50"),
      ]);
      if (own === generation && id === routingRead)
        Object.assign(state.routing, policy, {
          workerId: policy.workerId ?? "",
          workers: workers.workers,
          loaded: true,
          message: "",
        });
    } catch (error) {
      if (own === generation && id === routingRead && !expire(error, own))
        state.routing.message = errorText(error);
    } finally {
      if (id === routingRead) state.routing.busy = false;
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
    const own = generation;
    state.routing.busy = true;
    const body = {
      mode: state.routing.mode,
      workerId:
        state.routing.mode === "manual" ? state.routing.workerId || null : null,
      order: state.routing.order,
    };
    try {
      await api("/v1/routing", body, "PUT");
      if (own === generation)
        state.routing.message =
          "Routing gespeichert. Bereits vergebene Arbeit bleibt erhalten.";
    } catch (error) {
      if (own === generation && !expire(error, own))
        state.routing.message = errorText(error);
    } finally {
      if (own === generation) state.routing.busy = false;
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
    const own = generation,
      taskId = state.selectedTask.id,
      id = ++routeWrite;
    state.taskRouting.busy = true;
    const valid = () =>
      own === generation &&
      state.selectedTask?.id === taskId &&
      id === routeWrite;
    try {
      await api(
        `/v1/tasks/${encodeURIComponent(taskId)}/routing`,
        { workerId: state.taskRouting.workerId.trim() || null },
        "PUT",
      );
      if (valid())
        state.taskRouting.message =
          "Ziel gespeichert. Projekt, Provider und Kapazität bleiben Voraussetzung.";
    } catch (error) {
      if (valid() && !expire(error, own))
        state.taskRouting.message = errorText(error);
    } finally {
      if (valid()) state.taskRouting.busy = false;
    }
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
        await showWorker(state.workerId);
      else await refresh();
    }
  }
  return {
    state,
    api,
    connect,
    disconnect,
    clearSession,
    navigate,
    refresh,
    movePage,
    showTask,
    showTaskId,
    closeTask,
    loadEvents,
    showWorker,
    closeWorker,
    submitTask,
    intakePayload,
    checkReadiness,
    loadRouting,
    saveRouting,
    saveTaskRouting,
    inspectSnapshots,
    poll,
    message,
  };
}
export type OrchestratorStore = ReturnType<typeof createOrchestratorStore>;
