import { DomainError } from '../../shared/errors.js';
import { validateDeliveryPolicySnapshot } from './delivery-policy.js';
import { gateDigest, type WorkerRequest } from './request-gates.js';
import { remotePublicationPending, type RemotePublicationView } from './remote-delivery-contracts.js';

export function remoteDeliverySubject(request: WorkerRequest) {
  const context = request.input.context as Record<string, unknown> | undefined;
  if (!context?.deliveryPolicy || typeof context.repositoryId !== 'string') throw new DomainError('conflict', 'This request has no accepted repository delivery policy.');
  const snapshot = validateDeliveryPolicySnapshot(context.deliveryPolicy), target = snapshot.configuration.remoteDelivery;
  if (!target) throw new DomainError('conflict', 'This request uses local-only delivery. Remote publication is not configured.');
  return { snapshot, target, repositoryId: context.repositoryId };
}
export function currentRemoteCandidate(request: WorkerRequest) {
  const run = request.delivery, candidate = run?.review?.candidate;
  if (!run || !candidate || !['review', 'done'].includes(request.phase) || run.status !== 'completed' ||
    candidate.requestId !== request.id || candidate.runId !== run.id || candidate.inputRevision !== request.inputRevision ||
    candidate.inputHash !== request.inputHash || candidate.policyDigest !== request.policyDigest ||
    run.inputRevision !== request.inputRevision || run.inputHash !== request.inputHash || run.policyDigest !== request.policyDigest) return null;
  return candidate;
}
export function remotePublicationView(request: WorkerRequest, authorized: boolean, reason: string | null, busy = false): RemotePublicationView {
  const candidate = currentRemoteCandidate(request), publications = structuredClone(request.delivery?.publications ?? []);
  let subject: ReturnType<typeof remoteDeliverySubject> | undefined;
  try { subject = remoteDeliverySubject(request); } catch (error) { reason = error instanceof DomainError ? error.message : 'Delivery configuration is unavailable.'; }
  const target = subject?.target ?? null, pending = remotePublicationPending(request.delivery);
  const confirmed = (action: 'push' | 'pull_request') => publications.some(item => item.action === action && item.status === 'confirmed' && candidate && gateDigest(item.candidate) === gateDigest(candidate));
  const eligible = !!candidate && authorized && !busy && !pending && !reason;
  return { configured: !!target, authorized: !!target && authorized, reason: reason ?? (busy ? 'A publication operation is active. Wait for its observation.' : pending ? 'Reconcile the saved remote outcome before another delivery action.' : !candidate ? 'A current verified review candidate is required before publication.' : null),
    target, candidate, canPush: eligible && !!target?.push && !confirmed('push'),
    canCreatePullRequest: eligible && !!target?.pullRequest && confirmed('push') && !confirmed('pull_request'),
    canReconcile: !!target && authorized && !busy && pending, publications };
}
/** Public PR prose contains approved summary and evidence, never private raw command output. */
export function remotePublicationContent(request: WorkerRequest): { title: string; body: string } {
  const review = request.delivery?.review;
  if (!review) throw new DomainError('conflict', 'A verified local review package is required.');
  const candidate = review.candidate, summary = /## Change summary\n\n([\s\S]*?)\n\n## Approved scope/.exec(review.markdown)?.[1] ?? 'Inspect the candidate diff and recorded criteria.';
  const cell = (value: string) => value.replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
  const body = `## Feature Request\n\n${request.id} · revision ${request.inputRevision}\n\n## Candidate\n\n- Delivery run: ${candidate.runId}\n- Baseline: ${candidate.baseline}\n- Candidate commit: ${candidate.candidateCommit}\n- Candidate digest: ${candidate.candidateDigest}\n\n## Implementation summary\n\n${summary}\n\n## Acceptance evidence\n\n| Criterion | Result |\n| --- | --- |\n` +
    review.criteria.map(criterion => `| ${cell(criterion.description)} | ${review.results.find(result => result.criterionId === criterion.id)?.status ?? 'unknown'} |`).join('\n') +
    '\n\n## Review boundary\n\nThis pull request publishes a verified worker candidate. Worker acceptance, repository review, integration checks and merge are separate decisions. Inspect the canonical Feature Request and local review evidence for human observations.\n';
  const title = request.input.title.replace(/[\r\n\x00-\x1f]+/g, ' ').trim().slice(0, 200);
  if (!title || Buffer.byteLength(body) > 60000) throw new DomainError('conflict', 'The generated pull request content exceeds the supported bound. Reduce the request summary before publishing.');
  return { title, body };
}
