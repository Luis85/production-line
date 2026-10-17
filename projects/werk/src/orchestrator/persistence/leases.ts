import { WorkerRouter } from "./routing.js";
import { randomUUID } from "node:crypto";
import { profiles, workerPolicy, repositoryScope } from "../../shared/contracts.js";
import type { Task } from "../../shared/contracts.js";
import { DomainError } from "../../shared/errors.js";
import { eligibleProfile } from "../policies.js";
import type { WorkerRecord } from "../../shared/protocol.js";
import type { StoreSession } from "./session.js";

/** Assignment and lease transitions; the Store owns every transaction. */
export class LeaseRepository {
  private readonly session: StoreSession;

  constructor(session: StoreSession) {
    this.session = session;
  }

  claim(
    w: WorkerRecord,
    claimKey: string = randomUUID(),
    queueCapacity?: number,
    repositoryIds?: string[],
    legacyRepository?: boolean,
  ): Task | null {
    if (typeof claimKey !== "string" || !/^[\w-]{1,100}$/.test(claimKey))
      throw new DomainError(
        "invalid_input",
        "requestId required: 1–100 letters, digits, _ or -",
      );
    const scope = repositoryScope(repositoryIds, legacyRepository);
    return this.session.transaction(() => {
      const stored = this.session.db.prepare("SELECT project,profiles,config FROM workers WHERE id=?").get(w.id);
      if (!stored || stored.project !== w.project) throw new DomainError("unauthorized", "Worker registration no longer exists.");
      const config = workerPolicy(JSON.parse(String(stored.config)));
      if (w.config.configHash !== config.configHash) throw new DomainError('conflict', 'Worker configuration changed before this assignment request.');
      w = { ...w, profiles: profiles(JSON.parse(String(stored.profiles))), config };
      const now = this.session.clock();
      this.session.db.prepare("UPDATE workers SET seen=? WHERE id=?").run(now, w.id);
      this.reapExpiredInsideTransaction();
      const prior = this.session.db
        .prepare("SELECT * FROM attempts WHERE worker=? AND claim_key=?")
        .get(w.id, claimKey) as any;
      if (prior) {
        const t = this.session.get(prior.task);
        return t.lease === prior.lease && t.status === "running" ? t : null;
      }
      if (queueCapacity !== undefined || repositoryIds !== undefined) {
        if (queueCapacity !== undefined && (
          !Number.isInteger(queueCapacity) ||
          queueCapacity < 0 ||
          queueCapacity > 64
        ))
          throw new DomainError("invalid_input", "queueCapacity: 0–64");
        w = { ...w, config: { ...w.config, ...(queueCapacity === undefined ? {} : { queueCapacity }), ...scope } };
        this.session.db
          .prepare("UPDATE workers SET config=? WHERE id=?")
          .run(JSON.stringify(w.config), w.id);
      }
      const active = this.session.db
        .prepare("SELECT * FROM tasks WHERE worker=? AND status='running'")
        .all(w.id) as any[];
      const activeTasks = active.map((row) => this.session.decode(row));
      if (
        activeTasks.length >=
        w.config.maxParallel + (w.config.queueCapacity ?? 0)
      )
        return null;
      const availableProviders = [
        ...new Set(
          w.profiles
            .filter(
              (profile) =>
                activeTasks.filter((task) => task.profile === profile.id)
                  .length <
                (profile.maxParallel ?? 1) + (w.config.queueCapacity ?? 0),
            )
            .map((profile) => profile.provider),
        ),
      ];
      if (!availableProviders.length) return null;
      const router = new WorkerRouter(this.session.db),
        policy = router.policy(w.project);
      const order =
        (policy.order === "worker" ? w.config.order : policy.order) === "fifo"
          ? "created,id"
          : "priority DESC,created,id";
      // Filter affinity in SQLite and fetch one row; queue size must not determine JS heap usage.
      const eligible = w.profiles.filter(
        (profile) =>
          activeTasks.filter((task) => task.profile === profile.id).length <
          (profile.maxParallel ?? 1) + (w.config.queueCapacity ?? 0),
      );
      const predicates = eligible
        .map(
          () =>
            "(COALESCE(json_extract(payload,'$.executionMode'),'mock')=? AND (json_extract(payload,'$.provider')='auto' OR json_extract(payload,'$.provider')=?))",
        )
        .join(" OR ");
      const workers = this.session.db
        .prepare("SELECT * FROM workers WHERE project=? AND seen>?")
        .all(w.project, now - this.session.ttl)
        .map((row: any) => ({
          worker: {
            ...row,
            profiles: JSON.parse(row.profiles),
            config: JSON.parse(row.config),
          } as WorkerRecord,
          active: (
            this.session.db
              .prepare(
                "SELECT * FROM tasks WHERE worker=? AND status='running'",
              )
              .all(row.id) as any[]
          ).map((item) => this.session.decode(item)),
        }));
      const repositoryFilter = w.config.repositoryIds === undefined ? "" : " AND ((json_extract(payload,'$.repository') IS NULL AND (COALESCE(json_extract(payload,'$.executionMode'),'mock')='mock' OR ?=1)) OR COALESCE(json_extract(payload,'$.repository'),json_extract(payload,'$.project')) IN (SELECT value FROM json_each(?)))";
      // Iterate the indexed queue without loading the whole backlog into memory.
      let candidate: Task | undefined;
      for (const row of this.session.db
        .prepare(
          "SELECT * FROM tasks WHERE status='queued' AND json_extract(payload,'$.project')=? AND (" +
            predicates +
            ")" + repositoryFilter + " ORDER BY " +
            order,
        )
        .iterate(
          w.project,
          ...eligible.flatMap((profile) => [profile.mode, profile.provider]),
          ...(w.config.repositoryIds === undefined ? [] : [w.config.legacyRepository ? 1 : 0, JSON.stringify(w.config.repositoryIds)]),
        )) {
        const task = this.session.decode(row);
        if (router.permits(task, w, workers, policy)) {
          candidate = task;
          break;
        }
      }
      if (!candidate) return null;
      const t = candidate,
        profile = eligibleProfile(w, t, activeTasks)!;
      this.session.db
        .prepare(
          "UPDATE tasks SET status='running',worker=?,lease=?,expires=?,attempt=attempt+1,profile=? WHERE id=?",
        )
        .run(w.id, randomUUID(), now + this.session.ttl, profile.id, t.id);
      this.session.event(t.id, "claimed", {
        workerId: w.id,
        profile: profile.id,
        mode: profile.mode,
        attempt: t.attempt + 1,
      });
      const assigned = this.session.get(t.id);
      this.session.db
        .prepare(
          "INSERT INTO attempts(task,attempt,worker,lease,profile,claim_key,config_hash,max_attempts,provider,mode) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          t.id,
          assigned.attempt,
          w.id,
          assigned.lease,
          profile.id,
          claimKey,
          w.config.configHash ?? "default",
          w.config.maxAttempts ?? 3,
          profile.provider,
          profile.mode,
        );
      return assigned;
    });
  }
  /** Reconcile leases without waiting for a live worker to claim another task. */
  reapExpired(): number {
    return this.session.transaction(() => this.reapExpiredInsideTransaction());
  }
  attemptLimit(task: string, attempt: number): number {
    const row = this.session.db
      .prepare("SELECT max_attempts FROM attempts WHERE task=? AND attempt=?")
      .get(task, attempt) as any;
    return row?.max_attempts ?? 3;
  }
  reapExpiredInsideTransaction(): number {
    const cutoff = this.session.clock();
    const select = this.session.db.prepare(
      "SELECT id,attempt,worker,lease FROM tasks WHERE status='running' AND expires<=? LIMIT 256",
    );
    let count = 0;
    // A cold restart may expire the entire fleet. Bound each read while retaining one atomic sweep.
    for (;;) {
      const expired = select.all(cutoff) as any[];
      if (!expired.length) return count;
      for (const row of expired) {
        const status =
          row.attempt >= this.attemptLimit(row.id, row.attempt)
            ? "blocked"
            : "queued";
        this.session.db
          .prepare(
            "UPDATE tasks SET status=?,worker=NULL,lease=NULL,expires=NULL,profile=NULL WHERE id=?",
          )
          .run(status, row.id);
        this.session.event(row.id, "lease_expired", {
          status,
          workerId: row.worker,
          attempt: row.attempt,
          lease: row.lease,
        });
      }
      count += expired.length;
    }
  }
  heartbeat(
    w: WorkerRecord,
    id: string,
    lease: unknown,
    attempt: unknown,
  ): Task {
    return this.session.transaction(() => {
      const t = this.session.get(id);
      this.session.checkLease(t, w, lease, attempt);
      this.session.db
        .prepare("UPDATE tasks SET expires=? WHERE id=?")
        .run(this.session.clock() + this.session.ttl, id);
      this.session.db
        .prepare("UPDATE workers SET seen=? WHERE id=?")
        .run(this.session.clock(), w.id);
      return this.session.get(id);
    });
  }
  current(w: WorkerRecord): Task[] {
    this.reapExpired();
    return this.session.db
      .prepare("SELECT * FROM tasks WHERE worker=? AND status='running'")
      .all(w.id)
      .map((r) => this.session.decode(r));
  }
}
