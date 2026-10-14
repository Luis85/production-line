import type { RecordData } from "./store";
export function deriveMetrics(
  records: RecordData[],
  filters: {
    taskId: string;
    project: string;
    worker: string;
    iteration: string;
    window: string;
    outcome: string;
  },
  now = Date.now(),
) {
  const matches = records.filter(
    ({ snapshot: s, receivedAt }) =>
      (!filters.taskId || s.taskId === filters.taskId) &&
      (!filters.project || s.project === filters.project) &&
      (!filters.worker || s.workerId === filters.worker) &&
      (!filters.iteration ||
        (s.provenance?.iterationId || "manual") === filters.iteration) &&
      (!Number(filters.window) ||
        Date.parse(receivedAt) >= now - Number(filters.window)),
  );
  const terminal = new Set(
    matches
      .filter(
        (r) =>
          r.snapshot.phase === "after" &&
          (!filters.outcome ||
            r.snapshot.execution.outcome === filters.outcome),
      )
      .map((r) => r.snapshot.pairId),
  );
  const selected = matches.filter(
    (r) => !filters.outcome || terminal.has(r.snapshot.pairId),
  );
  const after = selected.filter((r) => r.snapshot.phase === "after");
  const pairs = new Map<string, Set<string>>();
  for (const r of selected) {
    const phases = pairs.get(r.snapshot.pairId) ?? new Set();
    phases.add(r.snapshot.phase);
    pairs.set(r.snapshot.pairId, phases);
  }
  const failed = (r: RecordData) =>
    ["failed", "interrupted"].includes(r.snapshot.execution.outcome);
  const finite = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0;
  const portfolio = [...new Set(after.map((r) => r.snapshot.project))]
    .sort()
    .map((project) => {
      const rows = after.filter((r) => r.snapshot.project === project),
        values = rows
          .map((r) => r.snapshot.execution.durationMs)
          .filter(finite)
          .sort((a, b) => a - b);
      const percentile = (q: number) =>
        values.length
          ? Math.round(values[Math.max(0, Math.ceil(q * values.length) - 1)])
          : null;
      return {
        project,
        count: rows.length,
        failed: rows.filter(failed).length,
        p50: percentile(0.5),
        p95: percentile(0.95),
        measured: values.length,
        cli: rows.some((r) => r.snapshot.mode === "cli"),
      };
    });
  const measured = after
    .filter(
      (r) =>
        finite(r.snapshot.execution.durationMs) &&
        Number.isFinite(Date.parse(r.receivedAt)),
    )
    .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  const min = measured.length ? Date.parse(measured[0].receivedAt) : 0,
    max = measured.length ? Date.parse(measured.at(-1)!.receivedAt) : 0;
  const top = Math.max(
    1,
    ...measured.map((r) => r.snapshot.execution.durationMs),
  );
  const visible =
    measured.length <= 500
      ? measured
      : measured.filter(
          (_, i) =>
            i % Math.ceil(measured.length / 499) === 0 ||
            i === measured.length - 1,
        );
  const points = visible.map((r) => ({
    row: r,
    x:
      min === max
        ? 480
        : 85 + ((Date.parse(r.receivedAt) - min) / (max - min)) * 785,
    y: 175 - (r.snapshot.execution.durationMs / top) * 140,
  }));
  return {
    records: selected,
    after,
    pairs: pairs.size,
    complete: [...pairs.values()].filter(
      (p) => p.has("before") && p.has("after"),
    ).length,
    failed: after.filter(failed).length,
    portfolio,
    points,
    measured: measured.length,
    min,
    max,
    top,
  };
}
