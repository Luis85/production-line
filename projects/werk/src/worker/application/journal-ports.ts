import type { ExecutionStopObservation } from './execution-recovery.js';
import type { ReservedExecutionPermit } from './serial-executor.js';
import type { InteractionStore } from './interactions.js';
import type { RequestGatePort, RequestSummary, RequestEvent, GatePolicy, GateStage, GateReviewIntent, WorkerRequest } from './request-gates.js';
import type { RequestReviewPort } from './request-review.js';
import type { RunEvidence, RunOutcome, ProviderUsage, WorkerRun, RunQuery, RunPage, RunAnalysis } from './run-evidence.js';

export interface RequestQuery { sessionId?: string; phase?: string; limit?: number; after?: number; offset?: number; }
export interface RequestPage { schemaVersion: 1; rows: RequestSummary[]; requests: RequestSummary[]; total: number; nextOffset: number | null; nextAfter: number; hasMore: boolean; }
export interface RequestCatalog { get(id: string): WorkerRequest; list(query?: RequestQuery): RequestPage; }
export interface RemoteRequestGatePort extends RequestGatePort {
  execution(id: string, turnId: string): WorkerRequest['execution'] | undefined;
}
export interface FeatureIdentityJournal { bindFeature(sessionId: string, featureId: string): void; }
export interface RequestJournal extends RemoteRequestGatePort, RequestCatalog, RequestReviewPort, FeatureIdentityJournal {
  init(): Promise<void>;
  close(): void;
  unresolvedExecutions(): ReservedExecutionPermit[];
  events(id: string, after?: number, limit?: number): { schemaVersion: 1; requestId: string; events: RequestEvent[]; nextAfter: number; hasMore: boolean };
  policy(): { schemaVersion: 1; revision: number; policy: GatePolicy; digest: string };
  setPolicy(input: { policy: unknown; expectedRevision: number; operationId: string }): ReturnType<RequestJournal['policy']> & { duplicate: boolean };
  reserveReview(id: string, stage: GateStage): GateReviewIntent;
}
export type RecoveredRunResult = { outcome: Exclude<RunOutcome, 'queued' | 'running'>; usage: ProviderUsage };
export interface InteractionJournal extends InteractionStore {
  init(): Promise<void>;
  close(): void;
  retainSessions(sessionIds: string[]): void;
  resultForRun(id: string): RecoveredRunResult | undefined;
}
export interface RunJournal extends RunEvidence {
  init(recovery?: (id: string) => RecoveredRunResult | undefined, deliveryOwns?: (run: WorkerRun) => boolean): Promise<void>;
  uncertainExecutions(): WorkerRun[];
  recoveryReplay(input: unknown): WorkerRun | undefined;
  confirmExecutionStopped(input: unknown, observation: ExecutionStopObservation): WorkerRun;
  close(): void;
  observeUsage(id: string, usage: ProviderUsage): void;
  get(id: string): WorkerRun;
  latest(sessionId: string): WorkerRun | undefined;
  list(query?: RunQuery): RunPage;
  analyze(query?: RunQuery): RunAnalysis;
}
