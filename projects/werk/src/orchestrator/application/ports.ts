import { type SuccessorCommand, type SuccessorReceipt } from "../intake/successor.js";
import { type RequestGateEvidence } from "../../shared/request-gate.js";
import { type RegisteredCapabilities } from "../../shared/capabilities.js";
import type { ContextManifest } from "../../shared/context.js";
import type { OrchestratorOverview } from "../../shared/factory.js";
import type { Task } from "../../shared/contracts.js";
import type {
  SnapshotAcknowledgement,
  SnapshotQuery,
  SnapshotRecord,
  TaskEvent,
  WorkerRecord,
  WorkerProfilesRequest,
  WorkerProfilesResponse,
  WorkerSummary,
  WorkerDetail,
  PageQuery,
  PaginationMetadata,
  TaskListResponse,
  WorkerListResponse,
  TaskEventsResponse,
} from "../../shared/protocol.js";

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
  updateProfiles?(worker: WorkerRecord, input: WorkerProfilesRequest): WorkerProfilesResponse;
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
