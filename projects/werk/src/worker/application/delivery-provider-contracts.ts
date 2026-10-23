import type { DeliveryCandidate } from './delivery-review-contracts.js';
import type { ModelSelection } from './model-selection.js';
import { DomainError } from '../../shared/errors.js';
import { object } from '../../shared/contracts.js';
export interface DeliveryAssessmentResult {
  summary: string; findings: { id: string; severity: 'blocking' | 'warning'; message: string }[];
}
/** A model assessment is advisory evidence about this exact candidate, never a replacement for observed checks. */
export interface DeliveryCandidateAssessment extends DeliveryAssessmentResult {
  stepId: string; invocationRunId: string; profileId: string; selection: ModelSelection;
  candidate: DeliveryCandidate; evidenceDigest: string; dispatchDigest: string; at: string;
  passed: boolean;
}
/** Durable authorization to continue settled work in a fresh provider session. No native handle is transferred. */
export interface DeliveryProviderHandoff {
  id: string; sourceStepId: string; sourceProfileId: string; targetProfileId: string;
  sourceInvocationRunId: string; targetInvocationRunId: string; logicalSessionId: string;
  requestId: string; inputRevision: number; inputHash: string; deliveryRunId: string; policyDigest: string;
  reason: 'quota_exhausted' | 'rate_limited' | 'unavailable'; at: string;
  candidateDigest: string; checkpointCommit: string | null; baseline: string | null;
  summary: string; freshSession: true;
}
export function parseDeliveryAssessment(text: string): DeliveryAssessmentResult {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new DomainError('invalid_input', 'The candidate reviewer must return the documented JSON assessment.'); }
  const raw = object(value, 'Candidate assessment', ['summary', 'findings']);
  if (typeof raw.summary !== 'string' || !raw.summary.trim() || raw.summary.length > 8000 || !Array.isArray(raw.findings) || raw.findings.length > 32) throw new DomainError('invalid_input', 'Candidate review requires a bounded summary and at most 32 findings.');
  const findings = raw.findings.map(value => {
    const item = object(value, 'Candidate finding', ['id', 'severity', 'message']);
    if (typeof item.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(item.id) || typeof item.severity !== 'string' || !['blocking', 'warning'].includes(item.severity) || typeof item.message !== 'string' || !item.message.trim() || item.message.length > 4000) throw new DomainError('invalid_input', 'Candidate findings require a stable ID, severity and bounded explanation.');
    return { id: item.id, severity: item.severity as 'blocking' | 'warning', message: item.message.trim() };
  });
  if (new Set(findings.map(item => item.id)).size !== findings.length) throw new DomainError('invalid_input', 'Candidate finding IDs must be unique.');
  return { summary: raw.summary.trim(), findings };
}
