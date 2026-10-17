import type { StoreContext, StoreOperations } from './store-context';
import type { RecordData } from './store-contracts';
import { jsonRequestInit } from '../../shared/webview/http';
import { firstPage } from './store-contracts';

/** Access operations keep their own request and session fences. */
export function createAccess(context: StoreContext, actions: () => StoreOperations) {
  const { state, request, runtime, now } = context;

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
    return request(path, jsonRequestInit({
      method,
      body,
      signal,
      timeoutMs: 10000,
      headers: {
        Authorization: `Bearer ${credential}`,
        ...(key ? { "Idempotency-Key": key } : {}),
      },
    }));
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

  function clearSession(expired = false) {
    ++runtime.generation;
    ++runtime.readId;
    ++runtime.routingRead;
    ++runtime.readinessRead;
    runtime.readController?.abort();
    runtime.readController = null;
    actions().closeTask();
    actions().closeWorker();
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
      own === runtime.generation &&
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
    const id = ++runtime.connectId;
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
      if (id !== runtime.connectId) return;
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
      if (id === runtime.connectId)
        message(
          (error as any)?.status === 401
            ? "Token nicht akzeptiert. WERK_ADMIN_TOKEN dieser Linie prüfen."
            : "Verbindung nicht möglich. Prüfe Startterminal und Linienadresse und versuche erneut.",
          "error",
        );
    } finally {
      if (id === runtime.connectId) state.connecting = false;
    }
  }

  function disconnect() {
    if (state.submitting) return;
    ++runtime.connectId;
    state.connecting = false;
    clearSession();
    message(
      "Verbindung getrennt. Das Token wurde aus dem Seitenzustand entfernt.",
    );
  }

  return {
    message,
    api,
    applyAccess,
    clearSession,
    expire,
    connect,
    disconnect,
  };
}
