import type { FeatureIntakeMeasurement } from './feature-intake-measurement.js';
import type { DeliveryLifecycle, DeliveryStatus } from './delivery-contracts.js';
import type { RequestEvent, WorkerRequest } from './request-gates.js';
import type { WorkerRun } from './run-evidence.js';
export type DeliveryBlockerCategory = 'requirements' | 'environment' | 'permissions' | 'provider' | 'dependency' | 'budget' | 'operator' | 'unknown';
/** Explicit observations only. Missing observations never establish zero incidents or review time. */
export type DeliveryMetricObservation =
  | { kind: 'clarification'; questionId: string; cycleId: string; cause: string; answerTracking?: true }
  | { kind: 'clarification_answer'; questionId: string; cycleId: string; cause: string }
  | { kind: 'review_effort'; durationMs: number; source: 'user_reported' | 'instrumented' }
  | { kind: 'human_review_failure'; candidateDigest: string; criterionId: string }
  | { kind: 'recovery'; operationId: string; outcome: 'known' | 'unknown'; duplicateActions: boolean | null }
  | { kind: 'integrity_incident'; incidentId: string; incident: 'duplicate_dispatch' | 'duplicate_commit' | 'duplicate_publication' | 'unrelated_modification' }
  | { kind: 'integrity_audit'; auditId: string; scope: 'runtime' | 'release_acceptance'; incidentIds: string[] };
export interface DeliveryEventMeasurement {
  projectId: string | null;
  profileId: string | null;
  lifecycle: DeliveryLifecycle;
  deliveryStatus?: DeliveryStatus;
  blockers: { code: string; category: DeliveryBlockerCategory }[];
  observations?: DeliveryMetricObservation[];
}
/** Analysis projection of real journal or intake events; it is never a persisted execution event. */
export interface DeliveryMetricTimelineEvent {
  id: string; at: string; inputRevision: number | string; phase: string; type: string;
  measurement?: Pick<DeliveryEventMeasurement, 'blockers' | 'observations'>;
}
export interface DeliveryMetricsInput {
  /** Available filter identities are collected before a selected project narrows evidence. */
  availableProjects?: readonly string[]; availableProfiles?: readonly string[];
  intake?: readonly FeatureIntakeMeasurement[];
  requests: readonly WorkerRequest[];
  events: readonly RequestEvent[];
  runs: readonly WorkerRun[];
  /** Caller has read the entire retained event history for these requests, without pagination loss. */
  completeRequestIds: readonly string[];
}
export interface DeliveryMetricsQuery { since?: string; until?: string; projectId?: string; profileId?: string; }
export interface DeliveryMetricRate { numerator: number; denominator: number; unknown: number; percent: number | null; }
export interface DeliveryMetricDistribution { samples: number; unknown: number; p50Ms: number | null; p95Ms: number | null; totalMs: number | null; }
export interface DeliveryMetricsReport {
  schemaVersion: 1; scope: 'canonical_delivery_requests'; capturedAt: string;
  cohort: { since: string | null; until: string; projectId: string | null; profileId: string | null; requests: number; completeHistories: number; unknownSubmissionTimes: number; excludedUnknownSubmissionTimes: number; };
  projects: string[]; profiles: string[];
  autonomousReview: DeliveryMetricRate;
  firstFeedback: DeliveryMetricDistribution & { providerPortion: DeliveryMetricDistribution };
  clarification: { cycles: number; completedCycles: number; pendingCycles: number; unknownCycles: number; observedRequests: number; unknownRequests: number; completionMeasuredRequests: number; unknownCompletionRequests: number; groups: { profileId: string; cause: string; cycles: number; completedCycles: number; pendingCycles: number; unknownCycles: number }[] };
  verification: { firstPass: DeliveryMetricRate; eventualPass: DeliveryMetricRate; humanFailures: number; humanReviewedRequests: number };
  review: { effort: DeliveryMetricDistribution; effortSources: string[]; changesRequested: DeliveryMetricRate };
  recovery: DeliveryMetricRate;
  integrity: { incidents: number; auditedRequests: number; unknownRequests: number; releaseAudits: number; categories: { category: string; count: number }[] };
  blockers: { category: DeliveryBlockerCategory; waits: number; totalMs: number; active: number }[];
  blockerCoverage: { measuredRequests: number; unknownRequests: number };
  consumption: { acceptedRequests: number; measuredRequests: number; partialRequests: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; costMeasuredRequests: number; meanTokens: number | null; sources: string[]; costBases: string[] };
  notes: string[];
}
