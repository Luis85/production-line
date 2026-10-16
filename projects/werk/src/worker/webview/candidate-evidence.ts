import type { DevelopmentScopeView, DevelopmentEvidence } from '../application/development';
export interface DevelopmentTaskView {
  id: string; status: string; files: Array<{ path: string }>; hasPatch?: boolean; patch?: string | null; worktree?: string;
  implementation?: DevelopmentScopeView; developmentEvidence?: DevelopmentEvidence;
}
/** Present retained worker receipts; never infer an existing task's authority from current settings. */
export function candidateEvidenceView(task: DevelopmentTaskView) {
  const scope = task.implementation, evidence = task.developmentEvidence;
  if (!scope) return { implementation: false, verified: false, title: task.hasPatch || task.patch ? 'Proposed patch' : 'Proposal-only request', description: 'This request produces a review patch. Its proposed changes are not applied or automatically verified by this workflow.', checks: [], approvedPaths: task.files.map(file => file.path), changedPaths: [] as string[] };
  const checks = scope.checks.map(required => {
    const receipt = evidence?.checks.findLast(check => check.presetId === required.id);
    const sameCandidate = !!evidence?.candidateDigest && receipt?.candidateDigest === evidence.candidateDigest && receipt.presetFingerprint === required.fingerprint;
    const passed = sameCandidate && receipt?.status === 'passed' && receipt.exitCode === 0;
    const status = !receipt ? 'Not run' : !sameCandidate ? 'Needs rerun' : passed ? 'Passed' : receipt.status === 'interrupted' ? 'Interrupted' : 'Failed';
    return { id: required.id, name: required.name, status, passed, receipt };
  });
  const passed = checks.filter(check => check.passed).length;
  const verified = !!evidence?.candidateDigest && evidence.changedPaths.length > 0 && checks.length > 0 && passed === checks.length;
  const title = verified ? task.status === 'review' ? 'Implemented · checks passed' : 'Checks passed · handoff incomplete' : evidence?.changedPaths.length ? 'Implementation needs verification' : 'Implementation pending';
  const description = verified ? task.status === 'review' ? 'Required checks passed on the recorded changes. Human review and merge are still required.' : 'Required checks passed on the recorded changes. The worker has not completed the review handoff.' : !checks.length ? 'The saved verification plan is unavailable. This request cannot be shown as verified.' : !evidence?.changedPaths.length ? 'No changed candidate has been recorded. The worker must implement the request and pass its required checks.' : passed + ' of ' + checks.length + ' required checks passed on the recorded changes. Missing, failed or outdated checks block verified handoff.';
  return { implementation: true, verified, title, description, checks, approvedPaths: scope.approvedPaths, changedPaths: evidence?.changedPaths ?? [] };
}
