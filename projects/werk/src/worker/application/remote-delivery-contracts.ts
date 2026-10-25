import type { DeliveryCandidate } from './delivery-review-contracts.js';
import type { RemoteDeliveryPolicy } from './remote-delivery-policy.js';

export type RemotePublicationAction = 'push' | 'pull_request';
export type RemotePublicationStatus = 'pending' | 'unknown' | 'confirmed' | 'not_observed' | 'failed';
export type RemotePublicationCommand = 'push_candidate' | 'create_pull_request' | 'reconcile_publication';
export interface RemotePublicationObservation {
  branch: string;
  commit: string;
  pullRequest?: { number: number; url: string; state: 'open' | 'closed' | 'merged' };
}
/** A retained confirmed PR authorizes compare-and-swap updates to this request's owned branch. */
export interface RemotePublicationPredecessor {
  candidate: DeliveryCandidate;
  branch: string;
  pullRequest: NonNullable<RemotePublicationObservation['pullRequest']>;
}
/** One persisted intent concerns one immutable candidate and one approved destination. */
export interface RemotePublication {
  operationId: string;
  action: RemotePublicationAction;
  candidate: DeliveryCandidate;
  target: RemoteDeliveryPolicy;
  repositoryId: string;
  configurationDigest: string;
  predecessor?: RemotePublicationPredecessor;
  lastReconciliationOperationId?: string;
  status: RemotePublicationStatus;
  createdAt: string;
  updatedAt: string;
  detail: string;
  observation?: RemotePublicationObservation;
  integrityIncident?: 'duplicate_publication';
  recoveryEvidence?: 'single_remote_ref' | 'complete_pull_request_lookup';
}
export interface RemotePublicationResult {
  status: Exclude<RemotePublicationStatus, 'pending'>;
  detail: string;
  observation?: RemotePublicationObservation;
  integrityIncident?: 'duplicate_publication';
  recoveryEvidence?: 'single_remote_ref' | 'complete_pull_request_lookup';
}
export interface RemotePublicationUpdate {
  action: 'publication_result';
  deliveryRunId: string;
  operationId: string;
  result: RemotePublicationResult;
}
/** Public action availability is advisory; every command rechecks authorization and identity. */
export interface RemotePublicationView {
  configured: boolean;
  authorized: boolean;
  reason: string | null;
  target: RemoteDeliveryPolicy | null;
  candidate: DeliveryCandidate | null;
  canPush: boolean;
  canCreatePullRequest: boolean;
  canReconcile: boolean;
  publications: RemotePublication[];
}
export const remotePublicationCommands: readonly RemotePublicationCommand[] = ['push_candidate', 'create_pull_request', 'reconcile_publication'];
export function remotePublicationPending(run: { publications?: RemotePublication[] } | undefined): boolean {
  return run?.publications?.some(item => item.status === 'pending' || item.status === 'unknown') ?? false;
}
export function remotePublicationBranch(publication: Pick<RemotePublication, 'candidate' | 'predecessor'>): string {
  return publication.predecessor?.branch ?? publication.candidate.branch;
}
/** Remote adapters never edit a checkout, accept a candidate, merge, or release. */
export interface RemoteDeliveryPort {
  verify(candidate: DeliveryCandidate, signal: AbortSignal): Promise<void>;
  branch(target: RemoteDeliveryPolicy, branch: string, signal: AbortSignal): Promise<string | null>;
  push(target: RemoteDeliveryPolicy, candidate: DeliveryCandidate, signal: AbortSignal, previous?: { branch: string; commit: string }): Promise<void>;
  findPullRequest(publication: RemotePublication, signal: AbortSignal, allowPreviousEvidence?: boolean): Promise<RemotePublicationObservation['pullRequest'] | null>;
  updatePullRequest?(publication: RemotePublication, title: string, body: string, signal: AbortSignal): Promise<void>;
  createPullRequest(publication: RemotePublication, title: string, body: string, signal: AbortSignal): Promise<void>;
}
export interface RemotePublicationAuthorization {
  /** Revalidates current machine approval and target before every remote read or mutation. */
  authorize(repositoryId: string, configurationDigest: string, mutation?: boolean): void | Promise<void>;
}
