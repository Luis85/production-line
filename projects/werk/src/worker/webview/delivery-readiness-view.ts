import type { GateEvaluation, WorkerRequest } from '../application/request-gates';
import type { GateCommandFields } from './request-gate-controller';
export function readinessDecision(request: WorkerRequest, evaluation: GateEvaluation | null | undefined, proposalId: string, decision: 'accepted' | 'rejected', note: string): GateCommandFields | null {
  const assessment = evaluation?.readiness?.assessment;
  const proposal = evaluation?.readiness?.proposals.find(item => item.id === proposalId);
  if (!assessment || !proposal || !note.trim() || assessment.inputRevision !== request.inputRevision || assessment.inputHash !== request.inputHash || assessment.policyDigest !== request.policyDigest || ['accepted', 'rejected'].includes(proposal.status)) return null;
  return { action: 'readiness_decision', inputRevision: request.inputRevision, inputHash: request.inputHash, assessmentId: assessment.id, proposalId, decision, note: note.trim() };
}
export function reportedReviewMinutes(value: string): { valid: boolean; minutes?: number } {
  if (!value.trim()) return { valid: true };
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440 ? { valid: true, minutes } : { valid: false };
}
