import type { DevelopmentCheckEvidence, DevelopmentEvidence, DevelopmentScopeView } from './development.js';

export type DevelopmentVerificationStatus = 'not_run' | 'stale' | 'passed' | 'failed' | 'interrupted' | 'invalid';
export interface ClassifiedDevelopmentCheck {
  id: string; name: string; fingerprint: string;
  status: DevelopmentVerificationStatus; passed: boolean; receipt: DevelopmentCheckEvidence | undefined;
}

/** Node-free receipt classification shared by execution gates, review notes and the UI.
 * This evaluates recorded checks only; it does not prove the captured patch or completed turn.
 */
export function classifyDevelopmentEvidence(scope: DevelopmentScopeView, evidence?: DevelopmentEvidence) {
  const candidateDigest = evidence?.candidateDigest ?? null;
  const changedPaths = [...(evidence?.changedPaths ?? [])];
  const receipts = evidence?.checks ?? [];
  const requiredIds = new Set(scope.checks.map(check => check.id));
  const invalid = requiredIds.size !== scope.checks.length ||
    new Set(receipts.map(check => check.presetId)).size !== receipts.length ||
    receipts.some(check => !requiredIds.has(check.presetId)) ||
    new Set(changedPaths).size !== changedPaths.length || changedPaths.some(path => !scope.approvedPaths.includes(path));
  const checks: ClassifiedDevelopmentCheck[] = scope.checks.map(required => {
    const receipt = receipts.findLast(check => check.presetId === required.id);
    const current = !!candidateDigest && receipt?.candidateDigest === candidateDigest && receipt.presetFingerprint === required.fingerprint;
    const status: DevelopmentVerificationStatus = invalid ? 'invalid' : !receipt ? 'not_run' : !current ? 'stale' :
      receipt.status === 'passed' && receipt.exitCode === 0 ? 'passed' : receipt.status === 'interrupted' ? 'interrupted' : 'failed';
    return { id: required.id, name: required.name, fingerprint: required.fingerprint, status, passed: status === 'passed', receipt };
  });
  return { candidateDigest, changedPaths, checks, invalid,
    verified: !invalid && !!candidateDigest && changedPaths.length > 0 && checks.length > 0 && checks.every(check => check.passed) };
}
