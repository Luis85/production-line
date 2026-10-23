import type { DeliveryCandidateAssessment, DeliveryProviderHandoff } from './delivery-provider-contracts.js';
import type { DeliveryPlan, DeliveryEffectiveLimits } from './delivery-plan.js';
import type { DeliveryCriterionDecision } from './delivery-criterion-decisions.js';
import type { RemotePublication, RemotePublicationUpdate } from './remote-delivery-contracts.js';
import type { DevelopmentEvidence } from './development.js';
import type { DeliveryCandidate, DeliveryHumanOutcome, DeliveryReviewPackage } from './delivery-review-contracts.js';
import type { ModelRequest, ModelResult } from './model-contract.js';
import type { ProviderUsage } from './run-evidence.js';

export type DeliveryLifecycle = 'draft' | 'submitted' | 'ready' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
export type DeliveryStatus = 'queued' | 'running' | 'waiting' | 'pause_pending' | 'paused' | 'interrupting' | 'interrupted' | 'reconciling' | 'outcome_unknown' | 'failed' | 'completed' | 'cancelled';
export type DeliveryPhase = 'assessing' | 'planning' | 'preparing' | 'implementing' | 'verifying' | 'repairing' | 'packaging';
export type DeliveryControl = 'pause_after_step' | 'interrupt' | 'cancel' | 'resume' | 'retry' | 'reopen' | 'confirm_stopped';
export type DeliveryAction = 'cancel' | 'reconcile' | 'wait' | 'observe' | 'assess' | 'plan' | 'prepare' | 'implement' | 'verify' | 'repair' | 'package' | 'review' | 'review_candidate';
export type DeliveryCondition = 'cancel_requested' | 'unknown_outcome' | 'input_changed' | 'held' | 'paused' | 'active_step' | 'needs_ready' | 'needs_plan' | 'needs_prepare' | 'needs_implementation' | 'needs_verification' | 'repair_available' | 'repair_exhausted' | 'needs_package' | 'reviewable' | 'needs_review';
export type DeliveryNode =
  | { id: string; type: 'selector' | 'sequence'; children: DeliveryNode[] }
  | { id: string; type: 'condition'; condition: DeliveryCondition }
  | { id: string; type: 'action'; action: DeliveryAction; reason: string; waitingFor?: string };
export interface DeliveryProfile { schemaVersion: 1; id: string; version: number; root: DeliveryNode; }
export interface DeliveryDecision {
  profileId: string; profileVersion: number; selectedNode: string;
  selectedAction: DeliveryAction; reason: string; waitingFor: string | null;
  conditions: { nodeId: string; condition: DeliveryCondition; result: boolean }[];
}
export interface DeliveryStep {
  id: string; phase: DeliveryPhase; purpose?: 'candidate_review'; profileId?: string; handoffId?: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'outcome_unknown';
  turnId: string | null; invocationRunId: string | null;
  startedAt: string; finishedAt: string | null;
  dispatch?: ModelRequest; result?: ModelResult; usage?: ProviderUsage;
  detail: string | null; evidenceDigest?: string; evidence?: DevelopmentEvidence;
}
/** Trusted runtime observation; it does not claim orphaned process cessation. */
export interface DeliveryStopObservation {
  requestRevision: number; deliveryRunId: string; inputRevision: number;
  candidateDigest: string; observedAt: string;
}
export interface DeliveryRecoveryReceipt {
  source: 'operator_attestation'; operationId: string; note: string; at: string;
  candidateDigest: string;
}
export interface DeliveryRun {
  schemaVersion: 1; id: string; inputRevision: number; inputHash: string; policyDigest: string;
  profile: DeliveryProfile; profileDigest: string;
  status: DeliveryStatus; phase: DeliveryPhase;
  control: { action: 'pause_after_step' | 'interrupt' | 'cancel'; operationId: string; at: string } | null;
  holds: { code: string; reason: string }[];
  repairAttempts: number; maxRepairAttempts: number;
  startedAt: string; finishedAt: string | null;
  review?: DeliveryReviewPackage;
  plan?: DeliveryPlan; effectiveLimits?: DeliveryEffectiveLimits;
  criterionDecisions?: DeliveryCriterionDecision[]; publications?: RemotePublication[];
  assessments?: DeliveryCandidateAssessment[]; handoffs?: DeliveryProviderHandoff[];
  humanOutcomes?: DeliveryHumanOutcome[];
  recoveries?: DeliveryRecoveryReceipt[];
  checkpoints?: DeliveryCandidate[];
  steps: DeliveryStep[]; decision: DeliveryDecision;
  allowedControls: DeliveryControl[];
}
/** Trusted runtime port. External commands always pass through the request operation ledger. */
export type DeliveryUpdate =
  | RemotePublicationUpdate
  | { action: 'plan'; deliveryRunId: string; plan: DeliveryPlan; effectiveLimits: DeliveryEffectiveLimits }
  | { action: 'assessment'; deliveryRunId: string; assessment: DeliveryCandidateAssessment }
  | { action: 'handoff'; deliveryRunId: string; handoff: DeliveryProviderHandoff }
  | { action: 'start'; purpose?: 'candidate_review'; profileId?: string; handoffId?: string; deliveryRunId: string; stepId: string; phase: DeliveryPhase; turnId?: string; invocationRunId?: string; dispatch?: ModelRequest }
  | { action: 'finish'; deliveryRunId: string; stepId: string; status: 'completed' | 'failed' | 'interrupted' | 'outcome_unknown'; result?: ModelResult; usage?: ProviderUsage; detail?: string; evidenceDigest?: string; evidence?: DevelopmentEvidence }
  | { action: 'hold'; code: string; reason: string }
  | { action: 'clear_hold'; code: string }
  | { action: 'review'; deliveryRunId: string; review: DeliveryReviewPackage }
  | { action: 'checkpoint'; deliveryRunId: string; candidate: DeliveryCandidate }
  | { action: 'stale_review'; deliveryRunId: string; reason: string }
  | { action: 'stopped'; deliveryRunId: string; confirmed: boolean; failure?: boolean; detail?: string };
export interface DeliveryBlackboard {
  cancelRequested: boolean; outcomeUnknown: boolean; inputChanged: boolean;
  held: boolean; paused: boolean; activeStep: boolean; ready: boolean;
  planned: boolean; prepared: boolean; implemented: boolean; verified: boolean;
  reviewRequired?: boolean; reviewed?: boolean; reviewFailed?: boolean;
  verificationFailed: boolean; repairAvailable: boolean; packaged: boolean;
}
