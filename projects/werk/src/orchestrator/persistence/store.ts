import {
  successorCommand,
  canonicalValue,
  type SuccessorCommand,
  type SuccessorReceipt,
} from "../intake/successor.js";
import {
  validateRequestGateEvidence,
  type RequestGateEvidence,
} from "../../shared/request-gate.js";
import { WorkerRouter } from "./routing.js";
import {
  registeredCapabilities,
  workerDetail,
  operationalMetrics,
} from "./monitoring.js";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  taskInput,
  profiles,
  identifier,
  workerPolicy,
  repositoryScope,
  workerProfilesUpdate,
} from "../../shared/contracts.js";
import { validateSnapshot } from "../../shared/snapshots.js";
import type { OrchestratorOverview, TaskCounts } from "../../shared/factory.js";
import type { Task } from "../../shared/contracts.js";
import { DomainError } from "../../shared/errors.js";
import { migrateSchema } from "./schema.js";
import {
  eligibleProfile,
  assertLeaseOwnership,
  assertSnapshotAssignment,
} from "../policies.js";
import type {
  WorkerRecord,
  WorkerProfilesRequest,
  WorkerProfilesResponse,
  WorkerSummary,
  TaskEvent,
  SnapshotRecord,
  SnapshotAcknowledgement,
  SnapshotQuery,
} from "../../shared/protocol.js";
import type { OrchestratorRepository } from "../application.js";
import type { PageQuery } from "../../shared/protocol.js";
import { taskPage, workerPage, eventPage } from "./pagination.js";
import {
  CONTEXT_MANIFEST_MAX_BYTES,
  type ContextManifest,
} from "../../shared/context.js";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export class Store implements OrchestratorRepository {
  db: DatabaseSync;
  ttl: number;
  clock: () => number;
  private inTransaction = false;
  constructor(path: string, ttl = 60000, clock = Date.now) {
    if (!Number.isSafeInteger(ttl) || ttl < 1)
      throw new DomainError(
        "invalid_input",
        "Lease duration must be a positive integer",
      );
    this.ttl = ttl;
    this.clock = clock;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      // Install the bounded busy handler before journal-mode negotiation or schema locks.
      this.db.exec(
        "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
      );
      this.transaction(() => migrateSchema(this.db));
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  /** Read a coherent aggregate without exposing task payloads, profiles or credentials. */
  overview(project: string): OrchestratorOverview {
    return this.transaction(() => {
      this.reapExpiredInsideTransaction();
      const tasks: TaskCounts = {
        total: 0,
        queued: 0,
        running: 0,
        simulated: 0,
        blocked: 0,
      };
      for (const row of this.db
        .prepare(
          "SELECT status,COUNT(*) AS count FROM tasks WHERE json_extract(payload,'$.project')=? GROUP BY status",
        )
        .all(project) as { status: keyof TaskCounts; count: number }[]) {
        tasks[row.status] = row.count;
        tasks.total += row.count;
      }
      const now = this.clock();
      const workers = {
        total: 0,
        online: 0,
        offline: 0,
        slotsTotal: 0,
        slotsBusy: 0,
        slotsAvailable: 0,
      };
      for (const row of this.db
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
        if (now - row.seen < this.ttl) {
          workers.online++;
          workers.slotsAvailable += Math.max(0, capacity - busy);
        } else workers.offline++;
      }
      const counts = this.db
        .prepare(
          "SELECT COUNT(*) AS total,COALESCE(SUM(phase='before'),0) AS before,COALESCE(SUM(phase='after'),0) AS after FROM snapshots WHERE project=?",
        )
        .get(project) as { total: number; before: number; after: number };
      const modes = this.db
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
    const modes = this.db
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
    return registeredCapabilities(this.db, project, this.clock(), this.ttl);
  }
  workerDetail(project: string, id: string) {
    this.reapExpired();
    return workerDetail(this.db, project, id, this.clock(), this.ttl);
  }
  operationalMetrics(project: string, windowSeconds: number) {
    return operationalMetrics(
      this.db,
      project,
      this.clock(),
      this.ttl,
      windowSeconds,
    );
  }
  routing(project: string) {
    return new WorkerRouter(this.db).policy(project);
  }
  configureRouting(project: string, input: unknown) {
    return this.transaction(() =>
      new WorkerRouter(this.db).configure(project, input),
    );
  }
  routeTask(project: string, id: string, input: unknown) {
    return this.transaction(() => {
      const task = this.get(id);
      if (task.project !== project)
        throw new DomainError("not_found", "Task not found in this project");
      const result = new WorkerRouter(this.db).assign(task, input);
      this.event(id, "routing_changed", result);
      return result;
    });
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
  event(task: string, kind: string, detail: unknown) {
    this.db
      .prepare("INSERT INTO events(task,kind,at,detail) VALUES(?,?,?,?)")
      .run(task, kind, this.clock(), JSON.stringify(detail));
  }
  decode(row: any): Task {
    const receipt = this.db
      .prepare(
        "SELECT json_extract(payload,'$.requestGate') AS gate FROM snapshots WHERE task=? AND attempt=? AND phase='after'",
      )
      .get(row.id, row.attempt);
    const released = this.db
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
  /** Original normalized intake identifies retries, independently of any current repository binding. */
  submission(value: unknown, key: string): Task | undefined {
    const data = taskInput(value),
      digest = hash(JSON.stringify(data));
    if (typeof key !== "string" || !/^[\w:.-]{1,128}$/.test(key))
      throw new DomainError(
        "invalid_input",
        "Idempotency-Key required: 1–128 letters, digits, _, :, . or -",
      );
    const existing = this.db
      .prepare("SELECT * FROM tasks WHERE idem=?")
      .get(key) as any;
    if (!existing) return undefined;
    if (existing.digest !== digest)
      throw new DomainError(
        "conflict",
        "Idempotency key already used for a different task",
      );
    return this.decode(existing);
  }
  submit(value: unknown, key: string): Task {
    const data = taskInput(value);
    return this.transaction(() => {
      const existing = this.submission(value, key);
      if (existing) return existing;
      return this.insertSubmission(data, key);
    });
  }
  private insertSubmission(
    data: ReturnType<typeof taskInput>,
    key: string,
  ): Task {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO tasks(id,payload,status,priority,created,idem,digest) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        JSON.stringify(data),
        "queued",
        data.priority,
        this.clock(),
        key,
        hash(JSON.stringify(data)),
      );
    this.event(id, "submitted", {
      contextStatus: "unresolved",
      provider: data.provider,
    });
    return this.get(id);
  }
  submitResolved(value: unknown, key: string, manifest: ContextManifest): Task {
    const original = taskInput(value);
    return this.transaction(() => {
      // A concurrent resolver may have committed while Git was being read; never repin its result.
      const existing = this.submission(value, key);
      if (existing) return existing;
      return this.insertResolved(original, key, manifest);
    });
  }
  private insertResolved(
    original: ReturnType<typeof taskInput>,
    key: string,
    manifest: ContextManifest,
  ): Task {
    const { sha256, ...body } = manifest;
    if (
      manifest.project !== original.project ||
      manifest.requirement.wikilink !== original.requirementRef ||
      sha256 !== hash(JSON.stringify(body))
    )
      throw new DomainError(
        "invalid_input",
        "Context manifest does not match intake",
      );
    const encoded = JSON.stringify(manifest);
    if (Buffer.byteLength(encoded, "utf8") > CONTEXT_MANIFEST_MAX_BYTES)
      throw new DomainError(
        "too_large",
        "Serialized context manifest exceeds byte limit",
      );
    const derived = taskInput({
      ...original,
      title: manifest.requirement.title,
      criteria: manifest.requirement.acceptance,
    });
    const context = {
      sha256,
      commit: manifest.commit,
      featureId: manifest.requirement.featureId,
      path: manifest.requirement.path,
    };
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO tasks(id,payload,status,priority,created,idem,digest) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        JSON.stringify({ ...derived, context }),
        "queued",
        derived.priority,
        this.clock(),
        key,
        hash(JSON.stringify(original)),
      );
    this.db
      .prepare("INSERT INTO task_contexts(task,sha256,payload) VALUES(?,?,?)")
      .run(id, sha256, encoded);
    this.event(id, "submitted", {
      contextStatus: "pinned",
      contextManifestHash: sha256,
      provider: derived.provider,
    });
    return this.get(id);
  }
  successorSubmission(
    parentId: string,
    value: SuccessorCommand,
  ): SuccessorReceipt | undefined {
    const command = successorCommand(value),
      digest = hash(canonicalValue(command));
    const existing = this.db
      .prepare(
        "SELECT digest,child FROM task_successors WHERE parent=? AND operation_id=?",
      )
      .get(parentId, command.operationId);
    if (existing) {
      if (existing.digest !== digest)
        throw new DomainError(
          "conflict",
          "Successor operation already belongs to different input.",
        );
      return {
        task: this.get(String(existing.child)),
        parentTaskId: parentId,
        duplicate: true,
      };
    }
    const parent = this.get(parentId);
    const held = this.db
      .prepare(
        "SELECT detail FROM events WHERE task=? AND kind='gate_held' AND json_extract(detail,'$.attempt')=?",
      )
      .get(parentId, command.expectedAttempt);
    if (
      parent.status !== "blocked" ||
      parent.attempt !== command.expectedAttempt ||
      !held ||
      JSON.parse(String(held.detail)).gate.evaluationId !== command.evaluationId
    )
      throw new DomainError(
        "conflict",
        "Successor requires the current held attempt and gate evaluation.",
      );
    if (taskInput(command.input).project !== parent.project)
      throw new DomainError(
        "forbidden",
        "Successor project must match its parent.",
      );
    if (
      this.db
        .prepare(
          "SELECT child FROM task_successors WHERE parent=? AND attempt=? AND evaluation=?",
        )
        .get(parentId, command.expectedAttempt, command.evaluationId)
    )
      throw new DomainError(
        "conflict",
        "This held evaluation already has a successor.",
      );
    return undefined;
  }
  submitSuccessor(
    parentId: string,
    value: SuccessorCommand,
    manifest?: ContextManifest,
  ): SuccessorReceipt {
    const command = successorCommand(value),
      data = taskInput(command.input);
    return this.transaction(() => {
      const existing = this.successorSubmission(parentId, command);
      if (existing) return existing;
      const key = "successor:" + hash(parentId + ":" + command.operationId);
      const task = manifest
        ? this.insertResolved(data, key, manifest)
        : this.insertSubmission(data, key);
      this.db
        .prepare(
          "INSERT INTO task_successors(parent,attempt,evaluation,operation_id,digest,child) VALUES(?,?,?,?,?,?)",
        )
        .run(
          parentId,
          command.expectedAttempt,
          command.evaluationId,
          command.operationId,
          hash(canonicalValue(command)),
          task.id,
        );
      this.event(parentId, "successor_created", {
        taskId: task.id,
        attempt: command.expectedAttempt,
        evaluationId: command.evaluationId,
      });
      this.event(task.id, "predecessor_linked", {
        taskId: parentId,
        attempt: command.expectedAttempt,
        evaluationId: command.evaluationId,
      });
      return { task, parentTaskId: parentId, duplicate: false };
    });
  }
  context(id: string): ContextManifest {
    const record = this.db
      .prepare("SELECT payload FROM task_contexts WHERE task=?")
      .get(id);
    if (!record)
      throw new DomainError("not_found", "Pinned task context not found");
    return JSON.parse(String(record.payload));
  }
  workerContext(
    w: WorkerRecord,
    id: string,
    lease: string,
    attempt: number,
  ): ContextManifest {
    const assigned = this.db
      .prepare(
        "SELECT t.payload FROM attempts a JOIN tasks t ON t.id=a.task WHERE a.task=? AND a.attempt=? AND a.worker=? AND a.lease=?",
      )
      .get(id, attempt, w.id, lease);
    if (
      !assigned ||
      JSON.parse(String(assigned.payload)).project !== w.project
    ) {
      throw new DomainError(
        "forbidden",
        "Context does not belong to this worker assignment",
      );
    }
    // Historical attempt authority permits recovery reads only, never heartbeat or completion.
    return this.context(id);
  }
  get(id: string): Task {
    if (!this.inTransaction) this.reapExpired();
    const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
    if (!row) throw new DomainError("not_found", "Task not found");
    return this.decode(row);
  }
  list(): Task[] {
    this.reapExpired();
    return this.db
      .prepare("SELECT * FROM tasks ORDER BY created DESC, id")
      .all()
      .map((r) => this.decode(r));
  }
  taskPage(query: PageQuery) {
    this.reapExpired();
    return taskPage(this.db, query, (row) => this.decode(row));
  }
  workerPage(query: PageQuery) {
    this.reapExpired();
    return workerPage(this.db, query, this.clock(), this.ttl);
  }
  eventPage(id: string, query: PageQuery) {
    this.get(id);
    return eventPage(this.db, id, query);
  }
  register(
    project: string,
    value: unknown,
    policy?: unknown,
  ): {
    id: string;
    token: string;
  } {
    const ps = profiles(value),
      id = randomUUID(),
      token = randomUUID() + randomUUID();
    this.db
      .prepare(
        "INSERT INTO workers(id,project,profiles,token_hash,seen,config) VALUES(?,?,?,?,?,?)",
      )
      .run(
        id,
        identifier(project, "project"),
        JSON.stringify(ps),
        hash(token),
        this.clock(),
        JSON.stringify(workerPolicy(policy)),
      );
    return { id, token };
  }
  updateProfiles(w: WorkerRecord, input: WorkerProfilesRequest): WorkerProfilesResponse {
    const update = workerProfilesUpdate(input);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT project,profiles,config FROM workers WHERE id=?').get(w.id);
      if (!row || row.project !== w.project) throw new DomainError('unauthorized', 'Worker registration no longer exists.');
      const current = profiles(JSON.parse(String(row.profiles))), config = workerPolicy(JSON.parse(String(row.config)));
      if (config.configHash === update.configurationHash && canonicalValue(current) === canonicalValue(update.profiles))
        return { profiles: current, configurationHash: config.configHash };
      if (config.configHash !== update.expectedConfigurationHash || config.configHash === update.configurationHash)
        throw new DomainError('conflict', 'Worker configuration changed. Reload before editing profiles.');
      if (new Set(current.map(profile => profile.mode)).size !== 1 || current[0].mode !== update.profiles[0].mode)
        throw new DomainError('invalid_input', "Execution profiles must retain this worker's configured mode.");
      if (this.db.prepare("SELECT 1 FROM tasks WHERE worker=? AND status='running' LIMIT 1").get(w.id))
        throw new DomainError('conflict', 'Finish or abandon all accepted assignments before editing profiles.');
      if (this.db.prepare("SELECT 1 FROM attempts WHERE worker=? AND (provider IS NULL OR mode IS NULL OR provider NOT IN ('claude','codex') OR mode NOT IN ('mock','cli')) LIMIT 1").get(w.id))
        throw new DomainError('conflict', 'Historical profile authority is incomplete; profile edits are unavailable for this registration.');
      this.db.prepare('UPDATE workers SET profiles=?,config=? WHERE id=?').run(JSON.stringify(update.profiles), JSON.stringify({ ...config, configHash: update.configurationHash }), w.id);
      return { profiles: update.profiles, configurationHash: update.configurationHash };
    });
  }
  worker(token: string): WorkerRecord {
    const w = this.db
      .prepare(
        "SELECT id, project, profiles, seen, config FROM workers WHERE token_hash=?",
      )
      .get(hash(token)) as any;
    if (!w) throw new DomainError("unauthorized", "Invalid worker token");
    return {
      ...w,
      profiles: JSON.parse(w.profiles),
      config: JSON.parse(w.config),
    };
  }
  workers(): WorkerSummary[] {
    this.reapExpired();
    return this.db
      .prepare(
        "SELECT id, project, profiles, seen, config FROM workers ORDER BY seen DESC",
      )
      .all()
      .map((w: any) => ({
        ...w,
        profiles: JSON.parse(w.profiles),
        config: JSON.parse(w.config),
        online: this.clock() - w.seen < this.ttl,
      }));
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
    return this.transaction(() => {
      const stored = this.db.prepare("SELECT project,profiles,config FROM workers WHERE id=?").get(w.id);
      if (!stored || stored.project !== w.project) throw new DomainError("unauthorized", "Worker registration no longer exists.");
      const config = workerPolicy(JSON.parse(String(stored.config)));
      if (w.config.configHash !== config.configHash) throw new DomainError('conflict', 'Worker configuration changed before this assignment request.');
      w = { ...w, profiles: profiles(JSON.parse(String(stored.profiles))), config };
      const now = this.clock();
      this.db.prepare("UPDATE workers SET seen=? WHERE id=?").run(now, w.id);
      this.reapExpiredInsideTransaction();
      const prior = this.db
        .prepare("SELECT * FROM attempts WHERE worker=? AND claim_key=?")
        .get(w.id, claimKey) as any;
      if (prior) {
        const t = this.get(prior.task);
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
        this.db
          .prepare("UPDATE workers SET config=? WHERE id=?")
          .run(JSON.stringify(w.config), w.id);
      }
      const active = this.db
        .prepare("SELECT * FROM tasks WHERE worker=? AND status='running'")
        .all(w.id) as any[];
      const activeTasks = active.map((row) => this.decode(row));
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
      const router = new WorkerRouter(this.db),
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
      const workers = this.db
        .prepare("SELECT * FROM workers WHERE project=? AND seen>?")
        .all(w.project, now - this.ttl)
        .map((row: any) => ({
          worker: {
            ...row,
            profiles: JSON.parse(row.profiles),
            config: JSON.parse(row.config),
          } as WorkerRecord,
          active: (
            this.db
              .prepare(
                "SELECT * FROM tasks WHERE worker=? AND status='running'",
              )
              .all(row.id) as any[]
          ).map((item) => this.decode(item)),
        }));
      const repositoryFilter = w.config.repositoryIds === undefined ? "" : " AND ((json_extract(payload,'$.repository') IS NULL AND (COALESCE(json_extract(payload,'$.executionMode'),'mock')='mock' OR ?=1)) OR COALESCE(json_extract(payload,'$.repository'),json_extract(payload,'$.project')) IN (SELECT value FROM json_each(?)))";
      // Iterate the indexed queue without loading the whole backlog into memory.
      let candidate: Task | undefined;
      for (const row of this.db
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
        const task = this.decode(row);
        if (router.permits(task, w, workers, policy)) {
          candidate = task;
          break;
        }
      }
      if (!candidate) return null;
      const t = candidate,
        profile = eligibleProfile(w, t, activeTasks)!;
      this.db
        .prepare(
          "UPDATE tasks SET status='running',worker=?,lease=?,expires=?,attempt=attempt+1,profile=? WHERE id=?",
        )
        .run(w.id, randomUUID(), now + this.ttl, profile.id, t.id);
      this.event(t.id, "claimed", {
        workerId: w.id,
        profile: profile.id,
        mode: profile.mode,
        attempt: t.attempt + 1,
      });
      const assigned = this.get(t.id);
      this.db
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
    return this.transaction(() => this.reapExpiredInsideTransaction());
  }
  private attemptLimit(task: string, attempt: number): number {
    const row = this.db
      .prepare("SELECT max_attempts FROM attempts WHERE task=? AND attempt=?")
      .get(task, attempt) as any;
    return row?.max_attempts ?? 3;
  }
  private reapExpiredInsideTransaction(): number {
    const cutoff = this.clock();
    const select = this.db.prepare(
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
        this.db
          .prepare(
            "UPDATE tasks SET status=?,worker=NULL,lease=NULL,expires=NULL,profile=NULL WHERE id=?",
          )
          .run(status, row.id);
        this.event(row.id, "lease_expired", {
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
    return this.transaction(() => {
      const t = this.get(id);
      this.checkLease(t, w, lease, attempt);
      this.db
        .prepare("UPDATE tasks SET expires=? WHERE id=?")
        .run(this.clock() + this.ttl, id);
      this.db
        .prepare("UPDATE workers SET seen=? WHERE id=?")
        .run(this.clock(), w.id);
      return this.get(id);
    });
  }
  checkLease(t: Task, w: WorkerRecord, lease: unknown, attempt: unknown) {
    assertLeaseOwnership(t, w.id, lease, attempt, this.clock());
  }
  finish(w: WorkerRecord, id: string, lease: unknown, attempt: unknown): Task {
    return this.transaction(() => {
      const t = this.get(id);
      if (
        ["simulated", "review"].includes(t.status) &&
        t.workerId === w.id &&
        t.lease === lease &&
        t.attempt === attempt
      )
        return t;
      this.checkLease(t, w, lease, attempt);
      const pair = this.db
        .prepare(
          "SELECT phase,payload FROM snapshots WHERE task=? AND attempt=?",
        )
        .all(id, t.attempt) as any[];
      const live = t.executionMode === "cli";
      if (
        pair.length !== 2 ||
        !pair.some(
          (s) =>
            s.phase === "after" &&
            JSON.parse(s.payload).execution.outcome ===
              (live ? "change-set" : "simulated"),
        )
      )
        throw new DomainError(
          "conflict",
          "Before/after snapshots required before completion",
        );
      if (t.requestGate && (t.requestGate.stage !== "done" || t.requestGate.status !== "passed"))
        throw new DomainError("conflict", "Passed completion gate evidence is required before completion.");
      this.db
        .prepare("UPDATE tasks SET status=?,expires=NULL WHERE id=?")
        .run(live ? "review" : "simulated", id);
      this.event(id, live ? "review_ready" : "simulation_finished", {
        workerId: w.id,
        attempt,
        prCreated: false,
        ...(live ? { mergeAllowed: false } : {}),
      });
      return this.get(id);
    });
  }
  events(id: string): TaskEvent[] {
    this.get(id);
    return this.db
      .prepare(
        "SELECT seq,kind,at,detail FROM events WHERE task=? ORDER BY seq",
      )
      .all(id)
      .map((e: any) => ({ ...e, detail: JSON.parse(e.detail) }));
  }
  current(w: WorkerRecord): Task[] {
    this.reapExpired();
    return this.db
      .prepare("SELECT * FROM tasks WHERE worker=? AND status='running'")
      .all(w.id)
      .map((r) => this.decode(r));
  }
  abandon(w: WorkerRecord, id: string, lease: unknown, attempt: unknown): Task {
    return this.transaction(() => {
      const t = this.get(id);
      const prior = this.db
        .prepare("SELECT worker,lease FROM attempts WHERE task=? AND attempt=?")
        .get(id, typeof attempt === "number" ? attempt : -1) as any;
      const alreadyAbandoned =
        prior?.worker === w.id &&
        prior?.lease === lease &&
        this.db
          .prepare(
            "SELECT 1 FROM events WHERE task=? AND kind='abandoned' AND json_extract(detail,'$.attempt')=?",
          )
          .get(id, typeof attempt === "number" ? attempt : -1);
      if (alreadyAbandoned) return t;
      this.checkLease(t, w, lease, attempt);
      const status =
        t.attempt >= this.attemptLimit(id, t.attempt) ? "blocked" : "queued";
      const after = this.db
        .prepare(
          "SELECT payload FROM snapshots WHERE task=? AND attempt=? AND phase='after'",
        )
        .get(id, t.attempt) as any;
      this.db
        .prepare(
          "UPDATE tasks SET status=?,worker=NULL,lease=NULL,expires=NULL,profile=NULL WHERE id=?",
        )
        .run(status, id);
      this.event(id, "abandoned", {
        workerId: w.id,
        attempt,
        status,
        outcome: after
          ? JSON.parse(after.payload).execution.outcome
          : "unavailable",
      });
      return this.get(id);
    });
  }
  hold(
    w: WorkerRecord,
    id: string,
    lease: unknown,
    attempt: unknown,
    value: RequestGateEvidence,
  ): Task {
    const gate = validateRequestGateEvidence(value);
    if (gate.status !== "blocked")
      throw new DomainError(
        "invalid_input",
        "Only a failed gate can hold a request.",
      );
    return this.transaction(() => {
      const task = this.get(id);
      const prior = this.db
        .prepare("SELECT worker,lease FROM attempts WHERE task=? AND attempt=?")
        .get(id, typeof attempt === "number" ? attempt : -1) as any;
      const held = this.db
        .prepare(
          "SELECT detail FROM events WHERE task=? AND kind='gate_held' AND json_extract(detail,'$.attempt')=?",
        )
        .get(id, typeof attempt === "number" ? attempt : -1) as any;
      if (prior?.worker === w.id && prior?.lease === lease && held) {
        if (
          canonicalValue(JSON.parse(held.detail).gate) !== canonicalValue(gate)
        )
          throw new DomainError(
            "conflict",
            "Gate hold receipt differs from the acknowledged receipt.",
          );
        return task;
      }
      this.checkLease(task, w, lease, attempt);
      const pair = this.db
        .prepare(
          "SELECT phase,payload FROM snapshots WHERE task=? AND attempt=?",
        )
        .all(id, task.attempt) as any[];
      const after = pair.find((row) => row.phase === "after");
      if (
        pair.length !== 2 ||
        !after ||
        canonicalValue(JSON.parse(after.payload).requestGate) !==
          canonicalValue(gate)
      )
        throw new DomainError(
          "conflict",
          "Matching paired gate evidence is required before holding a request.",
        );
      this.db
        .prepare(
          "UPDATE tasks SET status='blocked',worker=NULL,lease=NULL,expires=NULL,profile=NULL WHERE id=?",
        )
        .run(id);
      this.event(id, "gate_held", { workerId: w.id, attempt, gate });
      return this.get(id);
    });
  }
  resolveHold(
    w: WorkerRecord,
    id: string,
    lease: unknown,
    attempt: unknown,
    heldEvaluationId: string,
    value: RequestGateEvidence,
  ): Task {
    const gate = validateRequestGateEvidence(value);
    if (gate.status !== "passed" || gate.stage !== "done")
      throw new DomainError(
        "invalid_input",
        "Hold resolution requires a passed completion gate.",
      );
    identifier(heldEvaluationId, "heldEvaluationId");
    return this.transaction(() => {
      const task = this.get(id);
      const assignment = this.db
        .prepare("SELECT worker,lease FROM attempts WHERE task=? AND attempt=?")
        .get(id, typeof attempt === "number" ? attempt : -1) as any;
      if (
        task.project !== w.project ||
        assignment?.worker !== w.id ||
        assignment?.lease !== lease
      )
        throw new DomainError(
          "forbidden",
          "Hold resolution belongs to another worker assignment.",
        );
      const prior = this.db
        .prepare(
          "SELECT detail FROM events WHERE task=? AND kind='gate_released' AND json_extract(detail,'$.attempt')=?",
        )
        .get(id, attempt as number);
      if (prior) {
        const receipt = JSON.parse(String(prior.detail));
        const { revision: recordedRevision, ...recordedDecision } =
          receipt.gate;
        const { revision, ...decision } = gate;
        if (
          receipt.heldEvaluationId !== heldEvaluationId ||
          revision < recordedRevision ||
          canonicalValue(recordedDecision) !== canonicalValue(decision)
        )
          throw new DomainError(
            "conflict",
            "Hold resolution differs from its acknowledged receipt.",
          );
        return task;
      }
      const held = this.db
        .prepare(
          "SELECT detail FROM events WHERE task=? AND kind='gate_held' AND json_extract(detail,'$.attempt')=?",
        )
        .get(id, attempt as number);
      if (task.status !== "blocked" || task.attempt !== attempt || !held)
        throw new DomainError(
          "conflict",
          "Hold resolution requires the current blocked attempt.",
        );
      const previous = validateRequestGateEvidence(
        JSON.parse(String(held.detail)).gate,
      );
      if (
        previous.evaluationId !== heldEvaluationId ||
        previous.stage !== "done" ||
        gate.evaluationId === previous.evaluationId ||
        gate.revision <= previous.revision ||
        gate.requestId !== previous.requestId ||
        gate.inputDigest !== previous.inputDigest ||
        gate.policyDigest !== previous.policyDigest
      )
        throw new DomainError(
          "conflict",
          "Hold resolution must evaluate the same accepted input and policy after the held decision.",
        );
      if (
        this.db
          .prepare(
            "SELECT child FROM task_successors WHERE parent=? AND attempt=? AND evaluation=?",
          )
          .get(id, attempt as number, heldEvaluationId)
      )
        throw new DomainError(
          "conflict",
          "This held request already has a successor.",
        );
      const pair = this.db
        .prepare(
          "SELECT phase,payload FROM snapshots WHERE task=? AND attempt=?",
        )
        .all(id, attempt as number) as any[];
      const after = pair.find((row) => row.phase === "after");
      const outcome = task.executionMode === "cli" ? "change-set" : "simulated";
      if (
        pair.length !== 2 ||
        !after ||
        JSON.parse(after.payload).execution.outcome !== outcome ||
        canonicalValue(JSON.parse(after.payload).requestGate) !==
          canonicalValue(previous)
      )
        throw new DomainError(
          "conflict",
          "Hold resolution requires the original successful result and matching gate evidence.",
        );
      this.db
        .prepare("UPDATE tasks SET status=?,expires=NULL WHERE id=?")
        .run(task.executionMode === "cli" ? "review" : "simulated", id);
      this.event(id, "gate_released", {
        workerId: w.id,
        attempt,
        heldEvaluationId,
        gate,
      });
      return this.get(id);
    });
  }
  snapshot(w: WorkerRecord, value: unknown): SnapshotAcknowledgement {
    const s = validateSnapshot(value);
    const body = JSON.stringify(s),
      digest = hash(body);
    return this.transaction(() => {
      const a = this.db
        .prepare("SELECT * FROM attempts WHERE task=? AND attempt=?")
        .get(s.taskId, s.attempt) as any;
      const task = this.get(s.taskId);
      assertSnapshotAssignment(
        s,
        task,
        a
          ? {
              workerId: a.worker,
              leaseId: a.lease,
              profileId: a.profile,
              configurationHash: a.config_hash,
              provider: a.provider,
              mode: a.mode,
            }
          : undefined,
        w,
      );
      const old = this.db
        .prepare(
          "SELECT digest FROM snapshots WHERE task=? AND attempt=? AND phase=?",
        )
        .get(s.taskId, s.attempt, s.phase) as any;
      if (old) {
        if (old.digest !== digest)
          throw new DomainError(
            "conflict",
            "Immutable snapshot already exists",
          );
        return { id: s.id, sha256: digest };
      }
      if (s.phase === "after") {
        const before = this.db
          .prepare(
            "SELECT captured,payload FROM snapshots WHERE task=? AND attempt=? AND phase='before'",
          )
          .get(s.taskId, s.attempt) as any;
        if (!before)
          throw new DomainError(
            "conflict",
            "Before snapshot must arrive first",
          );
        if (
          s.provenance.systemPromptHash !==
          JSON.parse(before.payload).provenance.systemPromptHash
        )
          throw new DomainError(
            "invalid_input",
            "Snapshot pair system prompt hash mismatch",
          );
        if (Date.parse(s.capturedAt) < Date.parse(before.captured))
          throw new DomainError(
            "invalid_input",
            "After snapshot predates before snapshot",
          );
      }
      this.db
        .prepare(
          "INSERT INTO snapshots(id,task,attempt,phase,worker,project,captured,received,digest,payload) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          s.id,
          s.taskId,
          s.attempt,
          s.phase,
          w.id,
          w.project,
          s.capturedAt,
          this.clock(),
          digest,
          body,
        );
      this.event(s.taskId, "snapshot_received", {
        id: s.id,
        phase: s.phase,
        sha256: digest,
        attempt: s.attempt,
      });
      return { id: s.id, sha256: digest };
    });
  }
  snapshots(query: SnapshotQuery = {}): SnapshotRecord[] {
    const limit = query.limit ?? 500,
      descending = query.order === "desc";
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1001)
      throw new DomainError("invalid_input", "Snapshot limit: 1–1001");
    if (query.order !== undefined && !["asc", "desc"].includes(query.order))
      throw new DomainError("invalid_input", "Snapshot order: asc or desc");
    if (
      (descending && query.after !== undefined) ||
      (!descending && query.before !== undefined)
    )
      throw new DomainError(
        "invalid_input",
        "Use after with ascending order or before with descending order",
      );
    const cursor = descending
      ? (query.before ?? Number.MAX_SAFE_INTEGER)
      : (query.after ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new DomainError(
        "invalid_input",
        "Snapshot cursor must be nonnegative",
      );
    return this.db
      .prepare(
        "SELECT rowid AS seq,* FROM snapshots WHERE rowid" +
          (descending ? "<" : ">") +
          "? AND (? IS NULL OR project=?) AND (? IS NULL OR worker=?) AND (? IS NULL OR task=?) ORDER BY rowid " +
          (descending ? "DESC" : "ASC") +
          " LIMIT ?",
      )
      .all(
        cursor,
        query.project ?? null,
        query.project ?? null,
        query.worker ?? null,
        query.worker ?? null,
        query.task ?? null,
        query.task ?? null,
        limit,
      )
      .map((r: any) => ({
        seq: r.seq,
        snapshot: JSON.parse(r.payload),
        sha256: r.digest,
        receivedAt: new Date(r.received).toISOString(),
      }));
  }
}
