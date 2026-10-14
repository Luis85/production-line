export interface DiagnosticStatus {
  state: string;
  mode?: "mock" | "cli";
  maxParallel: number;
  activeTasks: { id: string; attempt: number; profile: string | null }[];
  profiles: { id: string; provider: string; mode: string }[];
  [key: string]: unknown;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export function validateStatus(value: unknown): DiagnosticStatus {
  if (
    !record(value) ||
    typeof value.state !== "string" ||
    (value.mode !== undefined &&
      value.mode !== "mock" &&
      value.mode !== "cli") ||
    !Number.isSafeInteger(value.maxParallel) ||
    Number(value.maxParallel) < 1 ||
    !Array.isArray(value.activeTasks) ||
    !Array.isArray(value.profiles) ||
    value.activeTasks.some(
      (task) =>
        !record(task) ||
        typeof task.id !== "string" ||
        !Number.isSafeInteger(task.attempt) ||
        (task.profile !== null && typeof task.profile !== "string"),
    ) ||
    value.profiles.some(
      (profile) =>
        !record(profile) ||
        ["id", "provider", "mode"].some(
          (key) => typeof profile[key] !== "string",
        ),
    ) ||
    ["completedSimulations", "completedReviews", "heartbeatErrors"].some(
      (key) =>
        value[key] !== undefined &&
        (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0),
    )
  )
    throw Error("Invalid worker status response");
  return value as DiagnosticStatus;
}
export function statusSummary(snapshot: DiagnosticStatus | null) {
  const live = snapshot?.mode === "cli";
  const labels: Record<string, string> = {
    starting: "Starting",
    idle: "Idle",
    executing: live ? "Executing Codex CLI" : "Executing simulations",
    standalone: "Standalone",
    disconnected: "Orchestrator disconnected",
    stopping: "Stopping",
    stopped: "Stopped",
  };
  return {
    state: snapshot
      ? (labels[snapshot.state] ?? snapshot.state)
      : "Status pending",
    execution: snapshot
      ? live
        ? "Codex CLI execution: real changes in the configured workspace."
        : "Mock execution: simulated attempts."
      : "Execution mode pending.",
    result: live
      ? "Acknowledged change sets are pending human review. Build, tests and acceptance are not verified; no automatic push or merge."
      : "A simulation is not an implemented feature or a completed PR.",
  };
}
export function createDiagnosticStore(
  initial: unknown = null,
  options: {
    fetcher?: typeof fetch;
    now?: () => number;
    reactive?: <T extends object>(value: T) => T;
  } = {},
) {
  const wrap = options.reactive ?? (<T extends object>(value: T) => value);
  const state = wrap({
    offline: initial !== null,
    snapshot: null as DiagnosticStatus | null,
    loading: false,
    paused: false,
    lastFetched: null as number | null,
    failed: false,
    announcement:
      initial !== null
        ? "Static export · measurements reflect the captured state."
        : "Loading worker status…",
  });
  let revision = 0,
    stopped = false;
  let controller: AbortController | null = null;
  if (state.offline) {
    try {
      state.snapshot = structuredClone(validateStatus(initial));
    } catch {
      state.failed = true;
      state.announcement =
        "This exported status is invalid. Obtain another export from the worker.";
    }
  }
  const announce = () => {
    state.announcement = state.failed
      ? "Status unavailable. " +
        (state.lastFetched !== null
          ? "Showing the last successful response. "
          : "No status received yet. ") +
        (state.paused
          ? "Automatic updates paused. Use Refresh now to retry."
          : "Retrying while this page is visible.")
      : state.paused
        ? "Automatic updates paused. Refresh now remains available."
        : "Live status available. Automatic updates are enabled.";
  };
  async function refresh() {
    if (state.offline || state.loading || stopped) return;
    state.loading = true;
    const own = ++revision;
    controller = new AbortController();
    try {
      const response = await (options.fetcher ?? fetch)("/status", {
        cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2500)]),
      });
      if (!response.ok) throw Error("Status unavailable");
      const snapshot = validateStatus(await response.json());
      if (own !== revision || stopped) return;
      state.snapshot = structuredClone(snapshot);
      state.lastFetched = (options.now ?? Date.now)();
      state.failed = false;
      announce();
    } catch {
      if (own === revision && !stopped) {
        state.failed = true;
        announce();
      }
    } finally {
      if (own === revision) {
        state.loading = false;
        controller = null;
      }
    }
  }
  async function setPaused(paused: boolean) {
    if (state.offline || stopped) return;
    state.paused = paused;
    announce();
    if (!paused) await refresh();
  }
  function close() {
    stopped = true;
    revision++;
    controller?.abort();
    controller = null;
    state.loading = false;
  }
  return { state, refresh, setPaused, close };
}
