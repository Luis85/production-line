import type { RequestGateEvidence } from '../../shared/request-gate.js';
import type { Adapter, Profile, Task, WorkerPolicy } from '../../shared/contracts.js';
import type { Snapshot } from '../../shared/snapshots.js';

export interface WorkerIdentity {
  id: string;
  token: string;
  project: string;
  url: string;
  configHash: string;
}

/** The worker application knows operations, never URLs or bearer tokens. */
export interface WorkerClient {
  currentAssignments(): Promise<Task[]>;
  claim(requestId: string, queueCapacity?: number): Promise<Task | null>;
  heartbeat(task: Task): Promise<Task>;
  /** Bound assignments require verified immutable context; unbound legacy mock tasks need none. */
  verifyContext?(task: Task): Promise<void>;
  publishSnapshot(snapshot: Snapshot): Promise<void>;
  complete(task: Task): Promise<void>;
  abandon(task: Task): Promise<void>;
  /** A gate refusal releases the lease without automatic failure retry. */
  hold?(task: Task, gate: RequestGateEvidence): Promise<void>;
  resolveHold?(task: Pick<Task, "id" | "lease" | "attempt">, heldEvaluationId: string, gate: RequestGateEvidence): Promise<void>;
}

export interface WorkerGateway {
  register(profiles: Profile[], policy: WorkerPolicy): Promise<Pick<WorkerIdentity, 'id' | 'token' | 'project'>>;
  connect(identity: WorkerIdentity): WorkerClient;
}

export interface SnapshotStatus {
  lastContact: string | null;
  heartbeatErrors: number;
}

export interface AttemptState extends SnapshotStatus {
  lastError: string | null;
  lastSnapshot: string | null;
  completedSimulations: number;
  completedReviews?: number;
}

export interface AttemptJournal {
  read(pairId: string, phase: string): Promise<Snapshot | null>;
  persist(snapshot: Snapshot): Promise<Snapshot>;
  capture(task: Task, workerId: string, profile: Profile, state: SnapshotStatus,
    phase: 'before' | 'after', before?: Snapshot, outcome?: Snapshot['execution']['outcome'],
    error?: string | null): Snapshot;
  flush(send: (snapshot: Snapshot) => Promise<unknown>): Promise<void>;
  /** Optional retention capability; only valid after snapshot and terminal server acknowledgments. */
  checkpoint?(pairId: string): Promise<void>;
}

export interface AttemptRequestGates {
  ready(task: Task): Promise<RequestGateEvidence>;
  recover(task: Task): Promise<Awaited<ReturnType<Adapter['run']>> | null>;
  start(task: Task): Promise<void>;
  completed(task: Task, result: Awaited<ReturnType<Adapter['run']>>): Promise<RequestGateEvidence>;
  failed(task: Task, outcome: 'failed' | 'interrupted'): Promise<void>;
}
export interface AttemptDependencies {
  gates?: AttemptRequestGates;
  client: WorkerClient;
  journal: AttemptJournal;
  adapter: Adapter;
  identity: Pick<WorkerIdentity, 'id' | 'project'>;
  profiles: Profile[];
  state: AttemptState;
  saveState(): Promise<void>;
  timeoutMs: number;
  /** Wall clock is used only for server lease expiry and human-readable contact time. */
  now?: () => number;
}
