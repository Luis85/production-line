import {
  successorCommand,
  type SuccessorCommand,
  type SuccessorReceipt,
} from "./intake/successor.js";
import {
  validateRequestGateEvidence,
  type RequestGateEvidence,
} from "../shared/request-gate.js";
import {
  defaultMonitoringThresholds,
  monitoringReport,
  operationalAlert,
  type MonitoringThresholds,
} from "../shared/monitoring.js";
import {
  validateLineCapabilities,
  type RegisteredCapabilities,
} from "../shared/capabilities.js";
import { identifier, object, taskInput, repositoryScope } from "../shared/contracts.js";
import type { ContextManifest } from "../shared/context.js";
import { assertPinnedIteration } from "./intake/iteration.js";
import { DomainError } from "../shared/errors.js";
import type { OrchestratorOverview } from "../shared/factory.js";
import type { Task } from "../shared/contracts.js";
import type {
  SnapshotAcknowledgement,
  SnapshotQuery,
  SnapshotRecord,
  TaskEvent,
  WorkerRecord,
  WorkerSummary,
  WorkerDetail,
  PageQuery,
  PaginationMetadata,
  TaskListResponse,
  WorkerListResponse,
  TaskEventsResponse,
} from "../shared/protocol.js";

/** Transactional operations required by the application, without SQLite or HTTP types. */
export interface OrchestratorRepository {
  routing?(project: string): unknown;
  configureRouting?(project: string, input: unknown): unknown;
  routeTask?(project: string, id: string, input: unknown): unknown;
  overview(project: string): OrchestratorOverview;
  operationalMetrics(
    project: string,
    windowSeconds: number,
  ): Record<string, number>;
  registeredCapabilities(project: string): RegisteredCapabilities;
  executionMode?(project: string): "mock" | "cli" | "mixed";
  workerDetail(project: string, id: string): WorkerDetail;
  successorSubmission?(
    parentId: string,
    input: SuccessorCommand,
  ): SuccessorReceipt | undefined;
  submitSuccessor?(
    parentId: string,
    input: SuccessorCommand,
    manifest?: ContextManifest,
  ): SuccessorReceipt;
  submit(input: unknown, idempotencyKey: string): Task;
  submission(input: unknown, idempotencyKey: string): Task | undefined;
  submitResolved(
    input: unknown,
    idempotencyKey: string,
    manifest: ContextManifest,
  ): Task;
  context(taskId: string): ContextManifest;
  workerContext(
    worker: WorkerRecord,
    taskId: string,
    lease: string,
    attempt: number,
  ): ContextManifest;
  list(): Task[];
  taskPage(query: PageQuery): TaskListResponse & PaginationMetadata;
  workerPage(query: PageQuery): WorkerListResponse & PaginationMetadata;
  eventPage(
    taskId: string,
    query: PageQuery,
  ): TaskEventsResponse & PaginationMetadata;
  get(taskId: string): Task;
  events(taskId: string): TaskEvent[];
  register(
    project: string,
    profiles: unknown,
    policy?: unknown,
  ): { id: string; token: string };
  worker(token: string): WorkerRecord;
  workers(): WorkerSummary[];
  current(worker: WorkerRecord): Task[];
  claim(
    worker: WorkerRecord,
    requestId: string,
    queueCapacity?: number,
    repositoryIds?: string[],
    legacyRepository?: boolean,
  ): Task | null;
  heartbeat(
    worker: WorkerRecord,
    taskId: string,
    lease: unknown,
    attempt: unknown,
  ): Task;
  finish(
    worker: WorkerRecord,
    taskId: string,
    lease: unknown,
    attempt: unknown,
  ): Task;
  abandon(
    worker: WorkerRecord,
    taskId: string,
    lease: unknown,
    attempt: unknown,
  ): Task;
  resolveHold?(
    worker: WorkerRecord,
    taskId: string,
    lease: unknown,
    attempt: unknown,
    heldEvaluationId: string,
    gate: RequestGateEvidence,
  ): Task;
  hold?(
    worker: WorkerRecord,
    taskId: string,
    lease: unknown,
    attempt: unknown,
    gate: RequestGateEvidence,
  ): Task;
  snapshot(worker: WorkerRecord, input: unknown): SnapshotAcknowledgement;
  snapshots(query: SnapshotQuery): SnapshotRecord[];
}

export interface TaskContextResolver {
  resolve(reference: string): Promise<ContextManifest>;
  assertOpen(): void;
}

export type WorkerAction =
  | "heartbeat"
  | "complete"
  | "abandon"
  | "hold"
  | "resolve-hold";

/** A resolved identity cannot be replaced by a worker ID supplied in a request body. */
export class WorkerOperations {
  private readonly repository: OrchestratorRepository;
  private readonly identity: WorkerRecord;

  constructor(repository: OrchestratorRepository, identity: WorkerRecord) {
    this.repository = repository;
    this.identity = identity;
  }

  current() {
    return { tasks: this.repository.current(this.identity) };
  }

  claim(input: unknown) {
    const body = object(input, "Assignment request", [
      "requestId",
      "queueCapacity",
      "repositoryIds",
      "legacyRepository",
    ]);
    if (
      typeof body.requestId !== "string" ||
      !/^[\w-]{1,100}$/.test(body.requestId)
    ) {
      throw new DomainError(
        "invalid_input",
        "requestId required: 1–100 letters, digits, _ or -",
      );
    }
    if (
      body.queueCapacity !== undefined &&
      (!Number.isInteger(body.queueCapacity) ||
        Number(body.queueCapacity) < 0 ||
        Number(body.queueCapacity) > 64)
    )
      throw new DomainError("invalid_input", "queueCapacity: 0–64");
    const scope = repositoryScope(body.repositoryIds, body.legacyRepository);
    return {
      task: this.repository.claim(
        this.identity,
        body.requestId,
        body.queueCapacity as number | undefined,
        scope.repositoryIds,
        scope.legacyRepository,
      ),
    };
  }

  snapshot(input: unknown) {
    return this.repository.snapshot(this.identity, input);
  }

  context(taskId: string, input: unknown): ContextManifest {
    const body = object(input, "Context assignment", ["lease", "attempt"]);
    if (
      typeof body.lease !== "string" ||
      !body.lease ||
      !Number.isSafeInteger(body.attempt) ||
      Number(body.attempt) < 1
    ) {
      throw new DomainError(
        "invalid_input",
        "lease string and positive integer attempt required",
      );
    }
    return this.repository.workerContext(
      this.identity,
      taskId,
      body.lease,
      body.attempt as number,
    );
  }

  execute(action: WorkerAction, taskId: string, input: unknown): Task {
    const body = object(
      input,
      "Lease command",
      action === "resolve-hold"
        ? ["lease", "attempt", "heldEvaluationId", "gate"]
        : action === "hold"
          ? ["lease", "attempt", "gate"]
          : ["lease", "attempt"],
    );
    if (
      typeof body.lease !== "string" ||
      !body.lease ||
      !Number.isSafeInteger(body.attempt) ||
      Number(body.attempt) < 1
    ) {
      throw new DomainError(
        "invalid_input",
        "lease string and positive integer attempt required",
      );
    }
    if (action === "resolve-hold") {
      if (!this.repository.resolveHold)
        throw new DomainError(
          "unavailable",
          "Request gate hold resolution is unsupported by this orchestrator.",
        );
      return this.repository.resolveHold(
        this.identity,
        taskId,
        body.lease,
        body.attempt,
        identifier(body.heldEvaluationId, "heldEvaluationId"),
        validateRequestGateEvidence(body.gate),
      );
    }
    if (action === "hold") {
      if (!this.repository.hold)
        throw new DomainError(
          "unavailable",
          "Request gate hold is unsupported by this orchestrator.",
        );
      return this.repository.hold(
        this.identity,
        taskId,
        body.lease,
        body.attempt,
        validateRequestGateEvidence(body.gate),
      );
    }
    switch (action) {
      case "heartbeat":
        return this.repository.heartbeat(
          this.identity,
          taskId,
          body.lease,
          body.attempt,
        );
      case "complete":
        return this.repository.finish(
          this.identity,
          taskId,
          body.lease,
          body.attempt,
        );
      case "abandon":
        return this.repository.abandon(
          this.identity,
          taskId,
          body.lease,
          body.attempt,
        );
    }
  }
}

export class OrchestratorApplication {
  readonly project: string;

  private readonly repository: OrchestratorRepository;
  private readonly monitoringConfig: MonitoringThresholds;

  private readonly contextResolver?: TaskContextResolver;

  constructor(
    repository: OrchestratorRepository,
    project: string,
    contextResolver?: TaskContextResolver,
    monitoringConfig: MonitoringThresholds = defaultMonitoringThresholds,
  ) {
    this.contextResolver = contextResolver;
    this.monitoringConfig = monitoringConfig;
    this.repository = repository;
    this.project = identifier(project, "project");
  }

  routing() {
    return (
      this.repository.routing?.(this.project) ?? {
        mode: "auto",
        workerId: null,
        order: "worker",
      }
    );
  }
  configureRouting(input: unknown) {
    if (!this.repository.configureRouting)
      throw new DomainError("conflict", "Routing configuration unavailable");
    return this.repository.configureRouting(this.project, input);
  }
  routeTask(id: string, input: unknown) {
    if (!this.repository.routeTask)
      throw new DomainError("conflict", "Task routing unavailable");
    return this.repository.routeTask(
      this.project,
      identifier(id, "taskId"),
      input,
    );
  }
  register(input: unknown) {
    const body = object(input, "Worker registration", ["profiles", "policy"]);
    return {
      ...this.repository.register(this.project, body.profiles, body.policy),
      project: this.project,
    };
  }

  worker(token: string): WorkerOperations {
    return new WorkerOperations(this.repository, this.repository.worker(token));
  }

  async createTask(input: unknown, idempotencyKey: string): Promise<Task> {
    const data = taskInput(input);
    if (data.project !== this.project)
      throw new DomainError(
        "forbidden",
        "Task project does not match server binding",
      );
    if (!this.contextResolver)
      return this.repository.submit(input, idempotencyKey);
    this.contextResolver.assertOpen();
    const existing = this.repository.submission(input, idempotencyKey);
    if (existing) return existing;
    object(input, "Bound requirement intake", [
      "project",
      "repository",
      "requirementRef",
      "provider",
      "priority",
      "executionMode",
    ]);
    if (!data.requirementRef)
      throw new DomainError(
        "invalid_input",
        "Bound intake requires project and requirementRef",
      );
    const manifest = await this.contextResolver.resolve(data.requirementRef);
    this.contextResolver.assertOpen();
    return this.repository.submitResolved(input, idempotencyKey, manifest);
  }

  async createSuccessor(
    parentId: string,
    value: unknown,
  ): Promise<SuccessorReceipt> {
    const id = identifier(parentId, "taskId"),
      command = successorCommand(value),
      data = taskInput(command.input);
    if (
      data.project !== this.project ||
      this.repository.get(id).project !== this.project
    )
      throw new DomainError(
        "forbidden",
        "Successor project does not match server binding.",
      );
    if (
      !this.repository.successorSubmission ||
      !this.repository.submitSuccessor
    )
      throw new DomainError("unavailable", "Successor intake is unavailable.");
    const existing = this.repository.successorSubmission(id, command);
    if (existing) return existing;
    if (!this.contextResolver)
      return this.repository.submitSuccessor(id, command);
    object((value as { input: unknown }).input, "Bound successor intake", [
      "project",
      "repository",
      "requirementRef",
      "provider",
      "priority",
      "executionMode",
    ]);
    if (!data.requirementRef)
      throw new DomainError(
        "invalid_input",
        "Bound successor intake requires requirementRef.",
      );
    this.contextResolver.assertOpen();
    const manifest = await this.contextResolver.resolve(data.requirementRef);
    this.contextResolver.assertOpen();
    // The repository repeats the parent/evaluation guard inside the same transaction as insertion.
    return this.repository.submitSuccessor(id, command, manifest);
  }

  async createIterationTask(
    input: unknown,
    idempotencyKey: string,
  ): Promise<Task> {
    if (!this.contextResolver)
      throw new DomainError(
        "invalid_input",
        "Pinned iteration intake requires a server context binding",
      );
    this.contextResolver.assertOpen();
    const data = taskInput(input);
    if (data.project !== this.project)
      throw new DomainError(
        "forbidden",
        "Task project does not match server binding",
      );
    if (!data.source || !data.requirementRef)
      throw new DomainError(
        "invalid_input",
        "Pinned iteration intake requires source and requirementRef",
      );
    const existing = this.repository.submission(input, idempotencyKey);
    if (existing) {
      if (!existing.context)
        throw new DomainError(
          "conflict",
          "Existing task has no pinned context; an explicit revision decision is required",
        );
      return existing;
    }
    const manifest = await this.contextResolver.resolve(data.requirementRef);
    await assertPinnedIteration(data, manifest);
    this.contextResolver.assertOpen();
    const task = this.repository.submitResolved(
      input,
      idempotencyKey,
      manifest,
    );
    if (!task.context)
      throw new DomainError(
        "conflict",
        "Existing task has no pinned context; an explicit revision decision is required",
      );
    return task;
  }

  taskContext(taskId: string) {
    return this.repository.context(taskId);
  }

  executionMode() {
    return this.repository.executionMode?.(this.project) ?? "mock";
  }

  overview() {
    const overview = this.repository.overview(this.project);
    const capabilities = validateLineCapabilities(
      {
        schemaVersion: 1,
        project: this.project,
        execution: overview.mode,
        context: this.contextResolver ? "pinned" : "unbound",
        intake: this.contextResolver
          ? ["requirement_ref", "pinned_iteration"]
          : ["structured_task", "requirement_ref"],
        ...this.repository.registeredCapabilities(this.project),
        capacity: {
          kind: "observed",
          observedAt: overview.observedAt,
          workers: overview.workers,
        },
      },
      this.project,
    );
    return { ...overview, capabilities };
  }
  monitoring() {
    const thresholds = this.monitoringConfig,
      metrics = this.repository.operationalMetrics(
        this.project,
        thresholds.failureWindowSeconds,
      ),
      alerts = [];
    if (metrics.werk_queue_oldest_age_seconds >= thresholds.queueAgeSeconds)
      alerts.push(
        operationalAlert(
          "queue_stalled",
          "Queued work has exceeded the age threshold.",
          "Check eligible worker profiles, available slots and worker connectivity.",
        ),
      );
    if (metrics.werk_tasks_queued > 0 && metrics.werk_workers_online === 0)
      alerts.push(
        operationalAlert(
          "no_online_workers",
          "Queued work has no online workers.",
          "Start a worker for this line and inspect its connection status.",
          "critical",
        ),
      );
    if (metrics.werk_workers_offline > 0)
      alerts.push(
        operationalAlert(
          "workers_offline",
          "Registered workers have missed the contact deadline.",
          "Inspect the worker status and service logs before restarting its owning runtime.",
        ),
      );
    if (metrics.werk_attempt_failures_window >= thresholds.failedAttempts)
      alerts.push(
        operationalAlert(
          "attempt_failures",
          "Failed terminal evidence exceeds the window threshold.",
          "Inspect task events and terminal snapshots; fix the cause before retrying.",
        ),
      );
    if (
      metrics.werk_lease_expirations_window > 0 ||
      metrics.werk_leases_overdue > 0
    )
      alerts.push(
        operationalAlert(
          "lease_expirations",
          "Leases are overdue or expired in the observation window.",
          "Check heartbeat connectivity, worker load and lease reaper logs.",
        ),
      );
    if (metrics.werk_tasks_blocked > 0)
      alerts.push(
        operationalAlert(
          "tasks_blocked",
          "Tasks require an explicit recovery or gate decision.",
          "Review terminal evidence and gate receipts before creating a guarded successor.",
        ),
      );
    return monitoringReport(
      "orchestrator",
      Date.now(),
      metrics,
      alerts,
      thresholds,
    );
  }
  capabilities() {
    return this.overview().capabilities;
  }
  workerDetail(id: string) {
    return this.repository.workerDetail(this.project, id);
  }
  tasks(query?: PageQuery) {
    return query
      ? this.repository.taskPage(query)
      : { tasks: this.repository.list() };
  }
  task(taskId: string) {
    return this.repository.get(taskId);
  }
  taskEvents(taskId: string, query?: PageQuery) {
    return query
      ? this.repository.eventPage(taskId, query)
      : { events: this.repository.events(taskId) };
  }
  workers(query?: PageQuery) {
    return query
      ? this.repository.workerPage(query)
      : { workers: this.repository.workers() };
  }

  snapshots(query: SnapshotQuery = {}) {
    const order = query.order ?? "asc";
    const limit = query.limit ?? 500;
    if (
      !["asc", "desc"].includes(order) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000
    ) {
      throw new DomainError("invalid_input", "order asc|desc; limit 1–1000");
    }
    if (
      (order === "desc" && query.after !== undefined) ||
      (order === "asc" && query.before !== undefined)
    ) {
      throw new DomainError(
        "invalid_input",
        "Use after with ascending order or before with descending order",
      );
    }
    for (const cursor of [query.before, query.after]) {
      if (
        cursor !== undefined &&
        (!Number.isSafeInteger(cursor) || cursor < 0)
      ) {
        throw new DomainError(
          "invalid_input",
          "Snapshot cursor must be nonnegative",
        );
      }
    }
    const page = this.repository.snapshots({
      ...query,
      order,
      limit: limit + 1,
    });
    const snapshots = page.slice(0, limit);
    return {
      snapshots,
      nextCursor:
        snapshots.at(-1)?.seq ??
        (order === "asc" ? (query.after ?? 0) : (query.before ?? null)),
      hasMore: page.length > limit,
    };
  }
}
