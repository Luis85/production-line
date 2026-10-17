import { projects, waiting, project } from './simulation-model.mjs';

/** Evidence behavior for one isolated, local simulation. */
export function createEvidence(state, api) {
  function topology(lineId = state.currentLineId) {
    const ps = projects.filter(
        (p) =>
          (!lineId ||
            state.data.lines.find((l) => l.id === lineId)?.projectId === p.id) &&
          (state.filter === "all" || state.filter === p.id),
      ),
      nodes = [],
      edges = [],
      scopedTasks = state.data.tasks.filter((t) => !lineId || t.lineId === lineId);
    let cursor = 0;
    for (const p of ps) {
      const ws = state.data.workers.filter(
          (w) => (!lineId || w.lineId === lineId) && w.project === p.id,
        ),
        rows = Math.max(1, Math.ceil(ws.length / 2)),
        z = cursor + (rows - 1) * 65;
      nodes.push({
        id: p.id,
        kind: "team",
        x: -430,
        z,
        h: 35,
        w: 98,
        d: 68,
        name: p.name,
        sub: p.team,
        color: p.color,
      });
      nodes.push({
        id: "repo:" + p.id,
        kind: "repo",
        x: 390,
        z,
        h: 55,
        w: 90,
        d: 72,
        name: "Git · " + p.name,
        sub:
          scopedTasks.filter((t) => t.project === p.id && t.status === "review")
            .length + " PRs im Review",
        color: p.color,
      });
      edges.push({
        from: p.id,
        to: "orchestrator",
        kind: "command",
        color: p.color,
        animate: scopedTasks.some((t) => t.project === p.id && waiting(t)),
      });
      ws.forEach((w, i) => {
        nodes.push({
          id: w.id,
          kind: "worker",
          x: 30 + (i % 2) * 115,
          z: cursor + Math.floor(i / 2) * 130,
          h: 65,
          w: 62,
          d: 62,
          name: w.id,
          sub: api.busy(w) ? "FT-" + api.busy(w).id : api.workerStatus(w),
          color: w.online ? p.color : "#70828b",
          worker: w,
        });
        edges.push(
          {
            from: "orchestrator",
            to: w.id,
            kind: "command",
            color: p.color,
            animate: !!api.busy(w),
          },
          {
            from: w.id,
            to: "repo:" + p.id,
            kind: "git",
            color: p.color,
            animate: api.busy(w)?.status === "checks",
          },
        );
      });
      edges.push({
        from: "repo:" + p.id,
        to: "orchestrator",
        kind: "feedback",
        color: p.color,
        animate: scopedTasks.some(
          (t) => t.project === p.id && t.status === "review",
        ),
      });
      cursor += rows * 130 + 110;
    }
    const center = (cursor - 240) / 2;
    nodes.forEach((n) => (n.z -= center));
    nodes.push({
      id: "orchestrator",
      kind: "orchestrator",
      x: -205,
      z: 0,
      h: 110,
      w: 112,
      d: 100,
      name: "Orchestrator",
      sub: lineId
        ? state.data.lines.find((l) => l.id === lineId)?.name || "Linie"
        : "Taskboard · Scheduler",
      color: "#bfe5d5",
    });
    return { nodes, edges };
  }

  function demoSnapshot(t, phase, outcome = "simulated") {
    t.snapshots = t.snapshots || [];
    if (t.snapshots.some((s) => s.attempt === t.attempt && s.phase === phase))
      return;
    const w = state.data.workers.find((w) => w.id === t.worker),
      before = t.snapshots.find(
        (s) => s.attempt === t.attempt && s.phase === "before",
      );
    t.snapshots.push({
      schemaVersion: 2,
      id: `FT-${t.id}-a${t.attempt}-${phase}`,
      phase,
      attempt: t.attempt,
      taskId: t.id,
      workerId: t.worker,
      project: t.project,
      lineId: t.lineId,
      profileId: t.execution?.profileId || null,
      configurationVersion: t.configVersion || w?.configVersion || 1,
      capturedAt: new Date().toISOString(),
      tick: state.data.tick,
      source: "browser_simulation",
      leaseId: t.lease,
      repository: {
        name: project(t.project).repo,
        targetBranch: t.iterationBranch,
        baseCommit: t.sourceCommit || t.context?.baseCommit || null,
        pullRequest: t.pr,
      },
      execution: {
        outcome: phase === "before" ? "pending" : outcome,
        durationMs: null,
        elapsedTicks:
          phase === "after" && before
            ? Math.max(0, state.data.tick - before.tick)
            : null,
        reason: "Takte sind Simulationsschritte, keine gemessene Laufzeit",
      },
      resources: {
        scope: "worker_process",
        rssBytes: null,
        cpuTimeMs: null,
        reason: "Kein Zugriff auf einen Worker-Prozess",
      },
      usage: {
        inputTokens: null,
        outputTokens: null,
        providerReportedCostUsd: null,
        subscriptionAllocation: null,
        reason: "Keine Anbieter-Telemetrie",
      },
      quality: {
        state:
          phase === "before"
            ? "pending"
            : outcome === "checks_failed"
              ? "simulated_failed"
              : outcome === "simulated"
                ? "simulated_passed"
                : "not_evaluated",
        coveragePercent: null,
      },
      artifactPath: `.factory/runs/FT-${t.id}/attempt-${t.attempt}/lease-${t.attempt}/${phase}.json`,
    });
  }

  function snapshotSeries() {
    return api.taskList()
      .flatMap((t) =>
        (t.snapshots || [])
          .filter((s) => s.phase === "after")
          .map((after) => ({
            task: t,
            after,
            before: (t.snapshots || []).find(
              (s) => s.attempt === after.attempt && s.phase === "before",
            ),
          })),
      )
      .sort((a, b) => a.after.tick - b.after.tick || a.task.id - b.task.id);
  }

  return {
    topology,
    demoSnapshot,
    snapshotSeries,
  };
}
