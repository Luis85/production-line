import type { DevelopmentCheckEvidence, DevelopmentScope, DevelopmentEvidence, DevelopmentCandidate } from './development.js';

/** Exact source and authority reviewed by a person; unrelated newer attempts cannot inherit acceptance. */
export interface DeliveryCandidate {
  requestId: string;
  inputRevision: number;
  inputHash: string;
  runId: string;
  baseline: string;
  branch: string;
  candidateCommit: string;
  tree: string;
  candidateDigest: string;
  patchDigest: string;
  policyDigest: string;
  checkDefinitionDigest: string;
  createdAt: string;
}
export interface DeliveryCriterion {
  id: string;
  description: string;
  mandatory: boolean;
  evaluator: 'check' | 'human';
  checkId?: string;
}
export type DeliveryCriterionStatus = 'passed' | 'failed' | 'unknown' | 'stale' | 'not_applicable' | 'pending_human';
export interface DeliveryCriterionResult {
  criterionId: string;
  status: DeliveryCriterionStatus;
  evidenceRefs: string[];
  detail?: string;
}
export interface DeliveryHumanOutcome {
  criterionId: string;
  outcome: 'passed' | 'failed' | 'exempted';
  reason: string;
  actor: string;
  at: string;
}
export interface DeliveryCheckReceipt extends DevelopmentCheckEvidence {
  evidenceRef: string;
  command: { executable: string; args: string[] };
  environment: { platform: string; architecture: string; nodeVersion: string };
}
export interface DeliveryReviewPackage {
  schemaVersion: 1;
  candidate: DeliveryCandidate;
  criteria: DeliveryCriterion[];
  results: DeliveryCriterionResult[];
  checks: DeliveryCheckReceipt[];
  markdown: string;
  reviewNotePath?: string;
  publication: 'local_only';
}
export interface DeliveryReviewInput {
  candidate: DeliveryCandidate;
  scope: DevelopmentScope;
  evidence: DevelopmentEvidence;
  criteria: string[];
  summary: string;
  title: string;
  environment: DeliveryCheckReceipt['environment'];
  /** Trusted project policy, relative to the assigned repository. */
  reviewDirectory?: string;
}
export interface DeliveryCheckpointInput {
  requestId: string;
  inputRevision: number;
  inputHash: string;
  runId: string;
  title: string;
  scope: DevelopmentScope;
  candidate: DevelopmentCandidate;
  policyDigest: string;
}
/** Local delivery records commits and notes only; it has no remote publication operation. */
export interface LocalDeliveryPort {
  checkpoint(input: DeliveryCheckpointInput, signal: AbortSignal): Promise<DeliveryCandidate>;
  package(input: DeliveryReviewInput, signal: AbortSignal): Promise<DeliveryReviewPackage>;
  verify(candidate: DeliveryCandidate, signal: AbortSignal): Promise<void>;
}
