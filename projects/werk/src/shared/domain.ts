import type { RequestGateEvidence } from './request-gate.js';
import type { PinnedContextReference } from './context.js';
export type Provider = 'auto' | 'claude' | 'codex';
export interface TaskInput {
    project: string;
    /** Explicit operator opt-in; absent remains simulated. */
    executionMode?: 'mock' | 'cli';
    /** Display title; reference-only intake derives this without resolving content. */
    title: string;
    /** Vault-relative requirement note. Presence does not assert resolution or readiness. */
    requirementRef?: string;
    criteria: string[];
    wikilinks: string[];
    provider: Provider;
    priority: number;
    source?: {
        featureId: string;
        iterationId: string;
        branch: string;
        commit: string;
        path: string;
        iterationPrUrl: string;
        specSha256: string;
    };
}
export interface Task extends TaskInput {
    /** Numeric worker-owned gate receipt; absent on older workers. */
    requestGate?: RequestGateEvidence;
    /** Absent on legacy/unbound mock tasks; never accepted from intake clients. */
    context?: PinnedContextReference;
    id: string;
    status: 'queued' | 'running' | 'simulated' | 'review' | 'blocked';
    attempt: number;
    workerId: string | null;
    lease: string | null;
    expiresAt: number | null;
    createdAt: number;
    profile: string | null;
}
export interface Profile {
    id: string;
    provider: 'claude' | 'codex';
    mode: 'mock' | 'cli';
    maxParallel?: number;
}
export interface WorkerPolicy {
    queueCapacity?: number;
    maxParallel: number;
    order: 'priority' | 'fifo';
    maxAttempts: number;
    configHash: string;
}
export interface Adapter {
    readonly mode: 'mock' | 'cli';
    verifyReview?(task: Task, review: { baseCommit: string; patchSha256: string; patchBytes: number; artifactPath: string }): Promise<void>;
    run(task: Task, signal: AbortSignal): Promise<{
        kind: 'simulated' | 'change-set';
        summary: string;
        review?: { baseCommit: string; patchSha256: string; patchBytes: number; artifactPath: string };
    }>;
}
