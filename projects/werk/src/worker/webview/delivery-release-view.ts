import type { WorkerRequest } from '../application/request-gates';
import type { ReleaseOperation, ReleaseView } from '../application/release-contracts';
import type { GateCommandFields } from './request-gate-controller';
export type ReleaseCommand = 'merge_candidate' | 'build_release' | 'publish_release' | 'reconcile_release' | 'confirm_release_stopped';
export const releaseStatusLabels = { pending: 'Operation pending', unknown: 'Outcome unknown · reconcile first', confirmed: 'Confirmed', not_observed: 'Not found', failed: 'Failed' };
export function releaseCandidateMatches(request: WorkerRequest, view: ReleaseView): boolean {
  const candidate = request.delivery?.review?.candidate;
  return !!candidate && !!view.candidate && candidate.requestId === request.id && candidate.runId === request.delivery?.id && candidate.inputRevision === request.inputRevision && candidate.inputHash === request.inputHash && candidate.policyDigest === request.policyDigest &&
    ['requestId', 'runId', 'inputRevision', 'inputHash', 'policyDigest', 'candidateCommit', 'candidateDigest', 'baseline', 'branch', 'tree', 'patchDigest', 'checkDefinitionDigest'].every(key => candidate[key as keyof typeof candidate] === view.candidate![key as keyof typeof candidate]);
}
/** Every mutation carries the exact inspected candidate; the worker checks its current authority again. */
export function releaseCommand(request: WorkerRequest, view: ReleaseView, action: ReleaseCommand, input: { receipt?: ReleaseOperation; tag?: string; note?: string } = {}): GateCommandFields | null {
  if (!view.authorized || !releaseCandidateMatches(request, view)) return null;
  const recovery = action === 'reconcile_release' || action === 'confirm_release_stopped';
  const receipt = input.receipt;
  if (recovery && (!receipt || !['pending', 'unknown'].includes(receipt.status) || !view.state.operations.some(operation => operation.operationId === receipt.operationId))) return null;
  if (action === 'reconcile_release' && !view.canReconcile || action === 'confirm_release_stopped' && (!view.canConfirmStopped || receipt?.action !== 'build' || !input.note?.trim()) || action === 'merge_candidate' && !view.canMerge || action === 'build_release' && !view.canBuild || action === 'publish_release' && (!view.canPublish || !input.tag?.trim())) return null;
  const candidate = recovery ? receipt!.candidate : view.candidate!;
  if (candidate.requestId !== request.id || candidate.runId !== request.delivery?.id) return null;
  return { action, deliveryRunId: candidate.runId, inputRevision: candidate.inputRevision, candidateCommit: candidate.candidateCommit, candidateDigest: candidate.candidateDigest,
    ...(recovery ? { releaseOperationId: receipt!.operationId } : {}), ...(action === 'publish_release' ? { releaseTag: input.tag!.trim() } : {}), ...(action === 'confirm_release_stopped' ? { note: input.note!.trim() } : {}) };
}
export function releaseLink(view: ReleaseView): string | null {
  const published = view.state.published;
  if (!published || !view.target || published.commit !== view.state.merge?.mergeCommit || published.commit !== view.state.build?.commit || !published.assets.length) return null;
  try { const url = new URL(published.url); return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname === '/' + view.target.repository + '/releases/tag/' + encodeURIComponent(published.tag) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
