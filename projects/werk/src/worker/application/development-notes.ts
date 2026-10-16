import type { DevelopmentEvidence, DevelopmentScopeView } from './development.js';

/** Publish only stable verification identities and outcomes, never command configuration or raw output. */
export interface DevelopmentReviewEvidence {
  baseCommit: string;
  candidateDigest: string | null;
  changedPaths: string[];
  verified: boolean;
  checks: Array<{
    id: string; name: string; fingerprint: string;
    status: 'not_run' | 'stale' | 'passed' | 'failed' | 'interrupted';
    candidateDigest: string | null; exitCode: number | null; startedAt: string | null; finishedAt: string | null;
  }>;
}
export function projectDevelopmentEvidence(scope: DevelopmentScopeView, evidence?: DevelopmentEvidence): DevelopmentReviewEvidence {
  const candidateDigest = evidence?.candidateDigest ?? null;
  const checks: DevelopmentReviewEvidence['checks'] = scope.checks.map(required => {
    const result = evidence?.checks.findLast(check => check.presetId === required.id);
    const current = !!candidateDigest && result?.candidateDigest === candidateDigest && result.presetFingerprint === required.fingerprint;
    return { id: required.id, name: required.name, fingerprint: required.fingerprint,
      status: !result ? 'not_run' : !current ? 'stale' : result.status,
      candidateDigest: result?.candidateDigest ?? null, exitCode: result?.exitCode ?? null,
      startedAt: result?.startedAt ?? null, finishedAt: result?.finishedAt ?? null };
  });
  const changedPaths = [...(evidence?.changedPaths ?? [])];
  return { baseCommit: scope.baseCommit, candidateDigest, changedPaths, checks,
    verified: !!candidateDigest && changedPaths.length > 0 && checks.length > 0 && checks.every(check => check.status === 'passed' && check.exitCode === 0) };
}
const cell = (value: unknown) => String(value ?? 'Not recorded').replaceAll('|', '\\|').replace(/[\r\n\t]+/g, ' ');
/** A check result describes only its captured candidate, never an unverified later edit. */
export function renderDevelopmentEvidence(value: DevelopmentReviewEvidence): string {
  const rows = value.checks.map(check => `| ${cell(check.name)} (${cell(check.id)}) | ${check.status === 'not_run' ? 'Not run' : check.status === 'stale' ? 'Earlier candidate or check configuration' : cell(check.status)} | ${cell(check.exitCode)} | ${cell(check.fingerprint)} | ${cell(check.candidateDigest)} | ${cell(check.finishedAt)} |`).join('\n');
  return '## Worktree candidate\n\n- Base commit: `' + value.baseCommit + '`\n- Candidate SHA-256: ' + (value.candidateDigest ? '`' + value.candidateDigest + '`' : 'Not captured') + '\n- Verification: ' + (value.verified ? 'Required checks passed for this candidate.' : 'Required checks have not all passed for this candidate.') + '\n\n### Changed paths\n\n' + (value.changedPaths.length ? value.changedPaths.map(path => '- ' + cell(path)).join('\n') : 'No changed paths have been captured.') + '\n\n### Verification results\n\n| Check | Result | Exit code | Frozen check SHA-256 | Checked candidate SHA-256 | Finished |\n| --- | --- | --- | --- | --- | --- |\n' + rows + '\n\nCommand configuration and output remain in the worker. A passing check applies only to its recorded candidate and frozen command fingerprint; human review is still required.\n';
}
