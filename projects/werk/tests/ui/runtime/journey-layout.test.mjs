import test from "node:test";
import assert from "node:assert/strict";
import { frontend } from "../helpers/frontend-loader.mjs";
import { line, deferred } from "../helpers/runtime-harness.mjs";
const { deriveMetrics } = await frontend("src/orchestrator/webview/metrics.ts");
const row = (taskId, seq, phase = "before", durationMs = null) => ({
  seq,
  receivedAt: "2026-10-14T00:00:00Z",
  snapshot: {
    taskId,
    id: "snapshot-" + seq,
    pairId: taskId,
    phase,
    project: "demo",
    workerId: "worker",
    profileId: "mock",
    attempt: 1,
    provenance: { iterationId: "iteration" },
    execution: {
      outcome: phase === "before" ? "pending" : "simulated",
      durationMs,
    },
    resources: { rssBytes: 100 },
    health: { eventLoopDelayP95Ms: null },
  },
});
test("connection and route changes preserve a drafted intake without side-effect submission", async () => {
  const f = line(undefined, { connected: false });
  f.state.intake.title = "Preserve my draft";
  await f.connect("fixture");
  await f.navigate("workers");
  assert.equal(f.state.tab, "workers");
  f.disconnect();
  assert.equal(f.state.token, "");
  assert.equal(f.state.intake.title, "Preserve my draft");
  assert(f.calls.every((c) => c.method === "GET"));
});
test("task-to-snapshot journey replaces conflicting filters and immediately scopes cached metrics", async () => {
  const pending = deferred();
  const f = line(() => pending.promise);
  f.state.metrics = [row("selected", 1), row("other", 2)];
  Object.assign(f.state.metricFilters, {
    project: "wrong",
    worker: "wrong",
    iteration: "wrong",
    outcome: "failed",
    window: "1",
  });
  f.state.selectedSnapshot = row("other", 2);
  const navigation = f.inspectSnapshots("selected");
  assert.equal(f.state.selectedSnapshot, null);
  assert.equal(f.state.tab, "metrics");
  assert.deepEqual(f.state.metricFilters, {
    project: "",
    worker: "",
    iteration: "",
    outcome: "",
    window: "",
    taskId: "selected",
  });
  assert.deepEqual(
    deriveMetrics(f.state.metrics, f.state.metricFilters).records.map(
      (r) => r.snapshot.taskId,
    ),
    ["selected"],
  );
  f.state.metricFilters.taskId = "";
  assert.equal(
    deriveMetrics(f.state.metrics, f.state.metricFilters).records.length,
    2,
  );
  pending.resolve({ snapshots: [], hasMore: false });
  await navigation;
});
test("metrics uses all pairs for summaries while plot thinning and unknown duration stay explicit", () => {
  const records = Array.from({ length: 600 }, (_, i) =>
    row("task-" + i, i, "after", i),
  );
  records.push(
    row("unknown", 601, "after", null),
    row("task-0", 602, "before"),
  );
  const filters = {
    project: "",
    worker: "",
    iteration: "",
    outcome: "",
    window: "",
    taskId: "",
  };
  const summary = deriveMetrics(records, filters);
  assert.equal(summary.records.length, 602);
  assert.equal(summary.after.length, 601);
  assert.equal(summary.measured, 600);
  assert(summary.points.length <= 500);
  assert.equal(summary.portfolio[0].count, 601);
  assert.equal(summary.portfolio[0].measured, 600);
  assert.equal(summary.complete, 1);
  filters.outcome = "simulated";
  assert.equal(deriveMetrics(records, filters).complete, 1);
});
