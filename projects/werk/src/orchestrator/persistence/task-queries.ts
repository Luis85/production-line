import { validateRequestGateEvidence } from "../../shared/request-gate.js";
import { WorkerRouter } from "./routing.js";
import { registeredCapabilities, workerDetail, operationalMetrics } from "./monitoring.js";
import type { OrchestratorOverview, TaskCounts } from "../../shared/factory.js";
import type { Task } from "../../shared/contracts.js";
import { DomainError } from "../../shared/errors.js";
import type { TaskEvent } from "../../shared/protocol.js";
import type { PageQuery } from "../../shared/protocol.js";
import { taskPage, workerPage, eventPage } from "./pagination.js";
import type { StoreSession } from "./session.js";

/** Read projections and routing updates sharing the Store transaction session. */
export class TaskQueries {
  private readonly session: StoreSession;

  constructor(session: StoreSession) {
    this.session = session;
  }

  /** Read a coherent aggregate without exposing task payloads, profiles or credentials. */
  overview(project: string): OrchestratorOverview {
    return this.session.transaction(() => {
      this.session.reapExpiredInsideTransaction();
      const tasks: TaskCounts = {
        total: 0,
        queued: 0,
        running: 0,
        simulated: 0,
        blocked: 0,
      };
      for (const row of this.session.db
        .prepare(
          "SELECT status,COUNT(*) AS count FROM tasks WHERE json_extract(payload,'$.project')=? GROUP BY status",
        )
        .all(project) as { status: keyof TaskCounts; count: number }[]) {
        tasks[row.status] = row.count;
        tasks.total += row.count;
      }
      const now = this.session.clock();
      const workers = {
        total: 0,
        online: 0,
        offline: 0,
        slotsTotal: 0,
        slotsBusy: 0,
        slotsAvailable: 0,
      };
      for (const row of this.session.db
        .prepare(
          "SELECT w.id,w.seen,w.config,w.profiles,COUNT(t.id) AS busy FROM workers w LEFT JOIN tasks t ON t.worker=w.id AND t.status='running' AND json_extract(t.payload,'$.project')=? WHERE w.project=? GROUP BY w.id",
        )
        .all(project, project) as {
        id: string;
        seen: number;
        config: string;
        profiles: string;
        busy: number;
      }[]) {
        const capacity = Math.min(
          JSON.parse(row.config).maxParallel ?? 1,
          JSON.parse(row.profiles).reduce(
            (total: number, profile: { maxParallel?: number }) =>
              total + (profile.maxParallel ?? 1),
            0,
          ),
        );
        const busy = Number(row.busy);
        workers.total++;
        workers.slotsTotal += capacity;
        workers.slotsBusy += Math.min(capacity, busy);
        if (now - row.seen < this.session.ttl) {
          workers.online++;
          workers.slotsAvailable += Math.max(0, capacity - busy);
        } else workers.offline++;
      }
      const counts = this.session.db
        .prepare(
          "SELECT COUNT(*) AS total,COALESCE(SUM(phase='before'),0) AS before,COALESCE(SUM(phase='after'),0) AS after FROM snapshots WHERE project=?",
        )
        .get(project) as { total: number; before: number; after: number };
      const modes = this.session.db
        .prepare(
          "SELECT DISTINCT json_extract(p.value,'$.mode') AS mode FROM workers w,json_each(w.profiles) p WHERE w.project=? LIMIT 3",
        )
        .all(project) as { mode: string }[];
      const mode = modes.some((item) => item.mode === "cli")
        ? modes.some((item) => item.mode === "mock")
          ? "mixed"
          : "cli"
        : "mock";
      return {
        schemaVersion: 1,
        observedAt: new Date(now).toISOString(),
        mode,
        project,
        tasks,
        workers,
        snapshots: counts,
        cost: {
          amountUsd: null,
          reason: mode === "mock" ? "unavailable_mock" : "unavailable_provider",
        },
      };
    });
  }
  executionMode(project: string): "mock" | "cli" | "mixed" {
    const modes = this.session.db
      .prepare(
        "SELECT DISTINCT json_extract(p.value,'$.mode') AS mode FROM workers w,json_each(w.profiles) p WHERE w.project=? LIMIT 3",
      )
      .all(project) as { mode: string }[];
    return modes.some((item) => item.mode === "cli")
      ? modes.some((item) => item.mode === "mock")
        ? "mixed"
        : "cli"
      : "mock";
  }
  registeredCapabilities(project: string) {
    return registeredCapabilities(this.session.db, project, this.session.clock(), this.session.ttl);
  }
  workerDetail(project: string, id: string) {
    this.session.reapExpired();
    return workerDetail(this.session.db, project, id, this.session.clock(), this.session.ttl);
  }
  operationalMetrics(project: string, windowSeconds: number) {
    return operationalMetrics(
      this.session.db,
      project,
      this.session.clock(),
      this.session.ttl,
      windowSeconds,
    );
  }
  routing(project: string) {
    return new WorkerRouter(this.session.db).policy(project);
  }
  configureRouting(project: string, input: unknown) {
    return this.session.transaction(() =>
      new WorkerRouter(this.session.db).configure(project, input),
    );
  }
  routeTask(project: string, id: string, input: unknown) {
    return this.session.transaction(() => {
      const task = this.session.get(id);
      if (task.project !== project)
        throw new DomainError("not_found", "Task not found in this project");
      const result = new WorkerRouter(this.session.db).assign(task, input);
      this.session.event(id, "routing_changed", result);
      return result;
    });
  }
  decode(row: any): Task {
    const receipt = this.session.db
      .prepare(
        "SELECT json_extract(payload,'$.requestGate') AS gate FROM snapshots WHERE task=? AND attempt=? AND phase='after'",
      )
      .get(row.id, row.attempt);
    const released = this.session.db
      .prepare(
        "SELECT json_extract(detail,'$.gate') AS gate FROM events WHERE task=? AND kind='gate_released' AND json_extract(detail,'$.attempt')=? ORDER BY seq DESC LIMIT 1",
      )
      .get(row.id, row.attempt);
    const currentGate = released?.gate ?? receipt?.gate;
    const requestGate = currentGate
      ? validateRequestGateEvidence(JSON.parse(String(currentGate)))
      : undefined;
    return {
      ...(requestGate ? { requestGate } : {}),
      ...JSON.parse(row.payload),
      id: row.id,
      status: row.status,
      priority: row.priority,
      createdAt: row.created,
      attempt: row.attempt,
      workerId: row.worker,
      lease: row.lease,
      expiresAt: row.expires,
      profile: row.profile,
    };
  }
  list(): Task[] {
    this.session.reapExpired();
    return this.session.db
      .prepare("SELECT * FROM tasks ORDER BY created DESC, id")
      .all()
      .map((r) => this.session.decode(r));
  }
  taskPage(query: PageQuery) {
    this.session.reapExpired();
    return taskPage(this.session.db, query, (row) => this.session.decode(row));
  }
  workerPage(query: PageQuery) {
    this.session.reapExpired();
    return workerPage(this.session.db, query, this.session.clock(), this.session.ttl);
  }
  eventPage(id: string, query: PageQuery) {
    this.session.get(id);
    return eventPage(this.session.db, id, query);
  }
  events(id: string): TaskEvent[] {
    this.session.get(id);
    return this.session.db
      .prepare(
        "SELECT seq,kind,at,detail FROM events WHERE task=? ORDER BY seq",
      )
      .all(id)
      .map((e: any) => ({ ...e, detail: JSON.parse(e.detail) }));
  }
}
