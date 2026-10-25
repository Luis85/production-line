import type { DeliveryCandidate } from './delivery-review-contracts.js';
import type { ReleasePolicy } from './release-policy.js';

export interface ReleaseArtifact { name: string; bytes: number; sha256: string; }
export interface ReleaseMergeReceipt { pullRequest: number; headCommit: string; mergeCommit: string; url: string; mergedAt: string; }
export interface ReleaseBuildReceipt { operationId: string; commit: string; artifacts: ReleaseArtifact[]; manifestDigest: string; builtAt: string; }
export interface ReleasePublishedReceipt { tag: string; url: string; commit: string; assets: ReleaseArtifact[]; publishedAt: string; }
export interface ReleaseOperation {
  operationId: string; action: 'merge' | 'build' | 'publish';
  status: 'pending' | 'unknown' | 'confirmed' | 'not_observed' | 'failed';
  candidate: DeliveryCandidate; target: ReleasePolicy; repositoryId: string; configurationDigest: string;
  pullRequest: { number: number; url: string; branch: string };
  mergeCommit?: string; build?: ReleaseBuildReceipt; tag?: string;
  createdAt: string; updatedAt: string; detail: string;
  merge?: ReleaseMergeReceipt; built?: ReleaseBuildReceipt; published?: ReleasePublishedReceipt;
}
export interface DeliveryRelease { operations: ReleaseOperation[]; merge?: ReleaseMergeReceipt; build?: ReleaseBuildReceipt; published?: ReleasePublishedReceipt; }
export interface ReleaseResult {
  status: 'unknown' | 'confirmed' | 'not_observed' | 'failed'; detail: string;
  merge?: ReleaseMergeReceipt; built?: ReleaseBuildReceipt; published?: ReleasePublishedReceipt;
}
export interface ReleaseUpdate { action: 'release_result'; deliveryRunId: string; operationId: string; result: ReleaseResult; }
export interface ReleasePullRequest {
  number: number; url: string; branch: string; base: string; headCommit: string;
  closed: boolean; merged: boolean; mergeCommit: string | null; mergedAt: string | null;
}
export interface ReleasePort {
  pullRequest(operation: ReleaseOperation, signal: AbortSignal): Promise<ReleasePullRequest>;
  merge(operation: ReleaseOperation, signal: AbortSignal): Promise<void>;
  inspectBuild(operation: ReleaseOperation, signal: AbortSignal): Promise<ReleaseBuildReceipt | null>;
  build(operation: ReleaseOperation, signal: AbortSignal): Promise<ReleaseBuildReceipt>;
  inspectRelease(operation: ReleaseOperation, signal: AbortSignal): Promise<ReleasePublishedReceipt | null>;
  publish(operation: ReleaseOperation, signal: AbortSignal): Promise<void>;
}
export interface ReleaseAuthority { authorize(repositoryId: string, configurationDigest: string, mutation?: boolean): void | Promise<void>; }
export interface ReleaseView {
  configured: boolean; authorized: boolean; reason: string | null; target: ReleasePolicy | null;
  candidate: DeliveryCandidate | null; state: DeliveryRelease; canMerge: boolean; canBuild: boolean; canPublish: boolean; canReconcile: boolean; canConfirmStopped: boolean;
}
export const releaseCommands = ['merge_candidate', 'build_release', 'publish_release', 'reconcile_release', 'confirm_release_stopped'] as const;
export const releasePending = (release: DeliveryRelease | undefined) => release?.operations.some(item => item.status === 'pending' || item.status === 'unknown') ?? false;
