import { DomainError } from '../../shared/errors.js';
import type { GateInput, RequestCommand, WorkerRequest } from './request-gates.js';

/** Feedback is accepted through the current candidate-bound command; it cannot alter frozen scope or authority. */
export function reviewReworkInput(request: WorkerRequest, input: RequestCommand): GateInput | null {
  if (input.action !== 'request_changes') return null;
  const hold = request.deliveryHolds?.find(item => item.code === 'review_changes');
  if (!hold) return null; // The saved feedback already advanced to another input generation.
  const candidate = request.delivery?.review?.candidate;
  if (!candidate || candidate.candidateCommit !== input.candidateCommit || candidate.candidateDigest !== input.candidateDigest ||
      request.inputRevision !== input.inputRevision || hold.reason !== input.note?.trim() || !hold.reason)
    throw new DomainError('conflict', 'Rework must continue the exact saved candidate feedback. Refresh the Feature Request.');
  const message = request.input.message + '\n\n## Review feedback\n\n' + hold.reason;
  if (message.length > 64000) throw new DomainError('conflict', 'The accumulated request feedback exceeds the request input bound. Retain its history and create a successor request.');
  return { ...structuredClone(request.input), message };
}
