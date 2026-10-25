import type { DeliveryCandidate } from './delivery-review-contracts.js';
export interface LocalMergePreparation { mergeCommit: string; tree: string; metadataPaths?: string[]; }
export interface LocalMergeReceipt extends LocalMergePreparation {
  branch: string; previousHead: string; candidateCommit: string; mergedAt: string;
}
export interface LocalMergeOperation {
  operationId: string; status: 'pending' | 'unknown' | 'confirmed' | 'not_observed' | 'failed';
  repositoryId: string; checkoutPath: string; mainBranch: string; mainHead: string; candidate: DeliveryCandidate;
  createdAt: string; updatedAt: string; detail: string;
  preparation?: LocalMergePreparation; receipt?: LocalMergeReceipt;
}
export interface LocalMergeState { operations: LocalMergeOperation[]; merged?: LocalMergeReceipt; }
export interface LocalMergeResult { status: Exclude<LocalMergeOperation['status'], 'pending'>; detail: string; receipt?: LocalMergeReceipt; }
export type LocalMergeUpdate =
  | { action: 'local_merge_prepared'; deliveryRunId: string; operationId: string; preparation: LocalMergePreparation }
  | { action: 'local_merge_result'; deliveryRunId: string; operationId: string; result: LocalMergeResult };
export interface LocalMergeObservation { branch: string; head: string; tree: string; clean: boolean; candidateIncluded: boolean; }
export interface LocalMergePort {
  inspect(operation: LocalMergeOperation, signal: AbortSignal): Promise<LocalMergeObservation>;
  prepare(operation: LocalMergeOperation, signal: AbortSignal): Promise<LocalMergePreparation>;
  apply(operation: LocalMergeOperation, signal: AbortSignal): Promise<void>;
}
export interface LocalMergeView {
  configured: boolean; reason: string | null; candidate: DeliveryCandidate | null;
  target: { repositoryId: string; checkoutPath: string; branch: string; head: string } | null;
  state: LocalMergeState; canMerge: boolean; canReconcile: boolean;
}
export const localMergeCommands = ['merge_local_candidate', 'reconcile_local_merge'] as const;
export const localMergePending = (state: LocalMergeState | undefined): boolean => state?.operations.some(value => value.status === 'pending' || value.status === 'unknown') ?? false;
