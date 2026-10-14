import { frontend, deferred } from "./frontend-loader.mjs";
export { deferred };
export const lineModule = await frontend("src/orchestrator/webview/store.ts");
export const factoryModule = await frontend("src/factory/webview/store.ts");
export const diagnosticModule = await frontend(
  "src/worker/webview/status/store.ts",
);
export const page = (key, rows = [], nextCursor = null) => ({
  [key]: rows,
  hasMore: nextCursor !== null,
  nextCursor,
});
export const task = (id = "task-a", extra = {}) => ({
  id,
  title: "Review checkout retry behavior",
  status: "queued",
  project: "demo",
  ...extra,
});
export const worker = (id = "worker-a", extra = {}) => ({
  id,
  project: "demo",
  seen: 1,
  online: true,
  config: { maxParallel: 1, maxAttempts: 3, order: "fifo" },
  profiles: [{ id: "codex", provider: "codex", mode: "mock", maxParallel: 1 }],
  activeTasks: [],
  activeTasksTruncated: false,
  ...extra,
});
export const overview = (extra = {}) => ({
  project: "demo",
  tasks: {},
  workers: { online: 0, total: 0 },
  ...extra,
});
export const status = (extra = {}) => ({
  workerId: "worker-a",
  project: "demo",
  state: "idle",
  mode: "mock",
  maxParallel: 1,
  activeTasks: [],
  profiles: [],
  completedSimulations: 0,
  completedReviews: 0,
  ...extra,
});
export const response = (value, code = 200) => ({
  ok: code >= 200 && code < 300,
  status: code,
  json: async () => value,
});
export const httpError = (status, message = "Unavailable") =>
  Object.assign(Error(message), { status });
export const tick = () => new Promise((resolve) => setImmediate(resolve));
export function line(
  handler = async () => undefined,
  { connected = true } = {},
) {
  const calls = [];
  let serial = 0;
  const store = lineModule.createOrchestratorStore({
    uuid: () => `intent-${++serial}`,
    now: () => 1000,
    request: async (path, init) => {
      calls.push({
        path,
        ...init,
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      const result = await handler(path, init);
      if (result !== undefined) return result;
      if (path === "/v1/overview") return overview();
      if (path.includes("/events?")) return page("events");
      if (path.startsWith("/v1/tasks?")) return page("tasks");
      if (path.startsWith("/v1/workers?")) return page("workers");
      if (path.startsWith("/v1/snapshots?")) return page("snapshots");
      if (path === "/v1/routing")
        return { mode: "auto", workerId: null, order: "worker" };
      throw Error("Unexpected request " + path);
    },
  });
  if (connected) {
    store.state.token = "fixture";
    store.state.canWrite = true;
  }
  return { ...store, calls };
}
export const factories = [
  { id: "root", name: "Root", parentId: null },
  { id: "child", name: "Child", parentId: "root" },
  { id: "leaf", name: "Leaf", parentId: "child" },
  { id: "other", name: "Other", parentId: null },
];
export const productionLine = {
  id: "line-a",
  name: "Line A",
  factoryId: "child",
  orchestratorUrl: "http://localhost:3000",
  webviewUrl: "http://localhost:3000",
  tokenEnv: "WERK_LINE_A_TOKEN",
};
export const factoryOverview = (extra = {}) => ({
  observedAt: new Date().toISOString(),
  lines: [],
  totals: { availableLines: 1, workers: { online: 1 } },
  ...extra,
});
export function factory(
  handler = async () => undefined,
  { connected = true } = {},
) {
  const calls = [];
  const store = factoryModule.createFactoryStore(async (path, init) => {
    calls.push({
      path,
      ...init,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    const result = await handler(path, init);
    if (result !== undefined) return result;
    if (path === "/v1/factories") return response({ factories });
    if (path === "/v1/lines") return response({ lines: [productionLine] });
    if (path.startsWith("/v1/overview")) return response(factoryOverview());
    if (path.includes("/routing"))
      return response({ mode: "auto", lineId: null, paused: false });
    if (path.startsWith("/v1/intake"))
      return response({
        tasks: [],
        total: 0,
        queued: 0,
        delivering: 0,
        delivered: 0,
      });
    throw Error("Unexpected request " + path);
  });
  if (connected)
    Object.assign(store.state, {
      token: "fixture",
      canWrite: true,
      factories: structuredClone(factories),
      lines: [{ ...productionLine }],
      intakeFactory: "root",
    });
  return { ...store, calls };
}
