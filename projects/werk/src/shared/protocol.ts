import type { Profile, Task, WorkerPolicy } from './domain.js';
import type { Snapshot } from './snapshots.js';
/** Authenticated worker data. Credentials are never included in public summaries. */
export interface WorkerRecord {
    id: string;
    project: string;
    profiles: Profile[];
    seen: number;
    config: WorkerPolicy;
}
export interface WorkerSummary extends WorkerRecord {
    online: boolean;
}
/** Admin projection; excludes worker credentials, config hashes and lease authority. */
export interface WorkerDetail {
    id: string;
    project: string;
    profiles: Profile[];
    seen: number;
    online: boolean;
    config: Pick<WorkerPolicy, 'maxParallel' | 'order' | 'maxAttempts'>;
    activeTasks: { id: string; status: 'running'; attempt: number; expiresAt: number | null; profile: string | null }[];
    activeTasksTruncated: boolean;
}
export interface TaskEvent {
    seq: number;
    kind: string;
    at: number;
    detail: unknown;
}
export interface SnapshotRecord {
    seq: number;
    snapshot: Snapshot;
    sha256: string;
    receivedAt: string;
}
export interface SnapshotAcknowledgement {
    id: string;
    sha256: string;
}
export interface SnapshotQuery {
    project?: string;
    worker?: string;
    task?: string;
    after?: number;
    before?: number;
    order?: 'asc' | 'desc';
    limit?: number;
}
export interface RegistrationRequest {
    profiles: Profile[];
    policy?: WorkerPolicy;
}
export interface RegistrationResponse {
    id: string;
    token: string;
    project: string;
}
export interface ClaimRequest {
    requestId: string;
    queueCapacity?: number;
    repositoryIds?: string[];
    legacyRepository?: boolean;
}
export interface ClaimResponse {
    task: Task | null;
}
export interface LeaseRequest {
    lease: string;
    attempt: number;
}
/** Supplying limit or cursor opts into a bounded, resumable collection page. */
export interface PageQuery {
    limit?: number;
    cursor?: string;
}
export interface PaginationMetadata {
    nextCursor: string | null;
    hasMore: boolean;
}
export interface TaskListResponse extends Partial<PaginationMetadata> {
    tasks: Task[];
}
export interface WorkerListResponse extends Partial<PaginationMetadata> {
    workers: WorkerSummary[];
}
export interface TaskEventsResponse extends Partial<PaginationMetadata> {
    events: TaskEvent[];
}
export interface SnapshotListResponse {
    snapshots: SnapshotRecord[];
    nextCursor: number | null;
    hasMore: boolean;
}
export interface HealthResponse {
    ok: boolean;
    mode: 'mock' | 'cli' | 'mixed';
    schema: number;
}
export interface ErrorResponse {
    error: string;
}
