import { type SuccessorCommand, type SuccessorReceipt } from "../intake/successor.js";
import { type RequestGateEvidence } from "../../shared/request-gate.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { OrchestratorOverview } from "../../shared/factory.js";
import type { Task } from "../../shared/contracts.js";
import { DomainError } from "../../shared/errors.js";
import { migrateSchema } from "./schema.js";
import { assertLeaseOwnership } from "../policies.js";
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
import type { OrchestratorRepository } from "../application/ports.js";
import type { PageQuery } from "../../shared/protocol.js";
import { type ContextManifest } from "../../shared/context.js";
import { createStoreSession } from "./session.js";
import { TaskQueries } from "./task-queries.js";
import { TaskIntakeRepository } from "./task-intake.js";
import { WorkerRegistryRepository } from "./worker-registry.js";
import { LeaseRepository } from "./leases.js";
import { TaskLifecycleRepository } from "./task-lifecycle.js";
import { SnapshotRepository } from "./snapshots.js";

/** Public persistence facade and sole owner of SQLite connection and transaction lifetime. */
export class Store implements OrchestratorRepository {
  db: DatabaseSync;
  ttl: number;
  clock: () => number;
  private inTransaction = false;
  private readonly queries: TaskQueries;
  private readonly intake: TaskIntakeRepository;
  private readonly registry: WorkerRegistryRepository;
  private readonly leases: LeaseRepository;
  private readonly lifecycle: TaskLifecycleRepository;
  private readonly snapshotsRepository: SnapshotRepository;

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

    const session = createStoreSession(this, {
      reapExpiredInsideTransaction: () => this.leases.reapExpiredInsideTransaction(),
      attemptLimit: (task, attempt) => this.leases.attemptLimit(task, attempt),
    });
    this.queries = new TaskQueries(session);
    this.intake = new TaskIntakeRepository(session);
    this.registry = new WorkerRegistryRepository(session);
    this.leases = new LeaseRepository(session);
    this.lifecycle = new TaskLifecycleRepository(session);
    this.snapshotsRepository = new SnapshotRepository(session);
  }

  /** Read a coherent aggregate without exposing task payloads, profiles or credentials. */
  overview(project: string): OrchestratorOverview {
    return this.queries.overview(project);
  }
  executionMode(project: string): "mock" | "cli" | "mixed" {
    return this.queries.executionMode(project);
  }
  registeredCapabilities(project: string) {
    return this.queries.registeredCapabilities(project);
  }
  workerDetail(project: string, id: string) {
    return this.queries.workerDetail(project, id);
  }
  operationalMetrics(project: string, windowSeconds: number) {
    return this.queries.operationalMetrics(project, windowSeconds);
  }
  routing(project: string) {
    return this.queries.routing(project);
  }
  configureRouting(project: string, input: unknown) {
    return this.queries.configureRouting(project, input);
  }
  routeTask(project: string, id: string, input: unknown) {
    return this.queries.routeTask(project, id, input);
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
    return this.queries.decode(row);
  }
  /** Original normalized intake identifies retries, independently of any current repository binding. */
  submission(value: unknown, key: string): Task | undefined {
    return this.intake.submission(value, key);
  }
  submit(value: unknown, key: string): Task {
    return this.intake.submit(value, key);
  }
  submitResolved(value: unknown, key: string, manifest: ContextManifest): Task {
    return this.intake.submitResolved(value, key, manifest);
  }
  successorSubmission(
    parentId: string,
    value: SuccessorCommand,
  ): SuccessorReceipt | undefined {
    return this.intake.successorSubmission(parentId, value);
  }
  submitSuccessor(
    parentId: string,
    value: SuccessorCommand,
    manifest?: ContextManifest,
  ): SuccessorReceipt {
    return this.intake.submitSuccessor(parentId, value, manifest);
  }
  context(id: string): ContextManifest {
    return this.intake.context(id);
  }
  workerContext(
    w: WorkerRecord,
    id: string,
    lease: string,
    attempt: number,
  ): ContextManifest {
    return this.intake.workerContext(w, id, lease, attempt);
  }
  get(id: string): Task {
    if (!this.inTransaction) this.reapExpired();
    const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
    if (!row) throw new DomainError("not_found", "Task not found");
    return this.decode(row);
  }
  list(): Task[] {
    return this.queries.list();
  }
  taskPage(query: PageQuery) {
    return this.queries.taskPage(query);
  }
  workerPage(query: PageQuery) {
    return this.queries.workerPage(query);
  }
  eventPage(id: string, query: PageQuery) {
    return this.queries.eventPage(id, query);
  }
  register(
    project: string,
    value: unknown,
    policy?: unknown,
  ): {
    id: string;
    token: string;
  } {
    return this.registry.register(project, value, policy);
  }
  updateProfiles(w: WorkerRecord, input: WorkerProfilesRequest): WorkerProfilesResponse {
    return this.registry.updateProfiles(w, input);
  }
  worker(token: string): WorkerRecord {
    return this.registry.worker(token);
  }
  workers(): WorkerSummary[] {
    return this.registry.workers();
  }
  claim(
    w: WorkerRecord,
    claimKey: string = randomUUID(),
    queueCapacity?: number,
    repositoryIds?: string[],
    legacyRepository?: boolean,
  ): Task | null {
    return this.leases.claim(w, claimKey, queueCapacity, repositoryIds, legacyRepository);
  }
  /** Reconcile leases without waiting for a live worker to claim another task. */
  reapExpired(): number {
    return this.leases.reapExpired();
  }
  heartbeat(
    w: WorkerRecord,
    id: string,
    lease: unknown,
    attempt: unknown,
  ): Task {
    return this.leases.heartbeat(w, id, lease, attempt);
  }
  checkLease(t: Task, w: WorkerRecord, lease: unknown, attempt: unknown) {
    assertLeaseOwnership(t, w.id, lease, attempt, this.clock());
  }
  finish(w: WorkerRecord, id: string, lease: unknown, attempt: unknown): Task {
    return this.lifecycle.finish(w, id, lease, attempt);
  }
  events(id: string): TaskEvent[] {
    return this.queries.events(id);
  }
  current(w: WorkerRecord): Task[] {
    return this.leases.current(w);
  }
  abandon(w: WorkerRecord, id: string, lease: unknown, attempt: unknown): Task {
    return this.lifecycle.abandon(w, id, lease, attempt);
  }
  hold(
    w: WorkerRecord,
    id: string,
    lease: unknown,
    attempt: unknown,
    value: RequestGateEvidence,
  ): Task {
    return this.lifecycle.hold(w, id, lease, attempt, value);
  }
  resolveHold(
    w: WorkerRecord,
    id: string,
    lease: unknown,
    attempt: unknown,
    heldEvaluationId: string,
    value: RequestGateEvidence,
  ): Task {
    return this.lifecycle.resolveHold(w, id, lease, attempt, heldEvaluationId, value);
  }
  snapshot(w: WorkerRecord, value: unknown): SnapshotAcknowledgement {
    return this.snapshotsRepository.snapshot(w, value);
  }
  snapshots(query: SnapshotQuery = {}): SnapshotRecord[] {
    return this.snapshotsRepository.snapshots(query);
  }
}
