import type { WorkerRequest } from './request-gates.js';

/** Exact-candidate human acceptance is shared authority for every delivery integration. */
export function deliveryAccepted(request: WorkerRequest): boolean {
  const run = request.delivery, execution = request.execution, candidate = run?.review?.candidate;
  const evaluation = request.evaluations.findLast(item => item.stage === 'done' && item.inputRevision === request.inputRevision && item.inputHash === request.inputHash && item.policyDigest === request.policyDigest && item.outputDigest === execution?.outputDigest);
  return !!request.attestation && request.attestation.inputHash === request.inputHash && request.attestation.outputDigest === execution?.outputDigest
    && !!candidate && candidate.inputRevision === request.inputRevision && candidate.inputHash === request.inputHash && candidate.policyDigest === request.policyDigest
    && execution?.inputRevision === request.inputRevision && execution.status === 'completed' && execution.result?.type === 'completed' && !!evaluation?.passed
    && !request.recoveryHold && !request.deliveryHolds?.length && !run?.holds.length && !run?.control
    && request.phase === 'done' && run?.status === 'completed';
}
