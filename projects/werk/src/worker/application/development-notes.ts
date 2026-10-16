import { classifyDevelopmentEvidence, type DevelopmentVerificationStatus } from './development-verification.js';
import type { DevelopmentEvidence, DevelopmentScopeView } from './development.js';

/** Publish only stable verification identities and outcomes, never command configuration or raw output. */
export interface DevelopmentReviewEvidence {
  baseCommit: string;
  candidateDigest: string | null;
  changedPaths: string[];
  verified: boolean;
  checks: Array<{
    id: string; name: string; fingerprint: string;
    status: DevelopmentVerificationStatus;
    candidateDigest: string | null; exitCode: number | null; startedAt: string | null; finishedAt: string | null;
  }>;
}
export function projectDevelopmentEvidence(scope: DevelopmentScopeView, evidence?: DevelopmentEvidence): DevelopmentReviewEvidence {
  const classified = classifyDevelopmentEvidence(scope, evidence);
  const checks = classified.checks.map(({ id, name, fingerprint, status, receipt }) => ({
    id, name, fingerprint, status,
    candidateDigest: receipt?.candidateDigest ?? null, exitCode: receipt?.exitCode ?? null,
    startedAt: receipt?.startedAt ?? null, finishedAt: receipt?.finishedAt ?? null,
  }));
  return { baseCommit: scope.baseCommit, candidateDigest: classified.candidateDigest,
    changedPaths: classified.changedPaths, checks, verified: classified.verified };
}
const cell = (value: unknown) => String(value ?? 'Not recorded').replaceAll('|', '\\|').replace(/[\r\n\t]+/g, ' ');
/** A check result describes only its captured candidate, never an unverified later edit. */
export function renderDevelopmentEvidence(value: DevelopmentReviewEvidence): string {
  const rows = value.checks.map(check => `| ${cell(check.name)} (${cell(check.id)}) | ${check.status === 'not_run' ? 'Not run' : check.status === 'stale' ? 'Earlier candidate or check configuration' : check.status === 'invalid' ? 'Invalid verification evidence' : cell(check.status)} | ${cell(check.exitCode)} | ${cell(check.fingerprint)} | ${cell(check.candidateDigest)} | ${cell(check.finishedAt)} |`).join('\n');
  return '## Worktree candidate\n\n- Base commit: `' + value.baseCommit + '`\n- Candidate SHA-256: ' + (value.candidateDigest ? '`' + value.candidateDigest + '`' : 'Not captured') + '\n- Verification: ' + (value.verified ? 'Required checks passed for this candidate.' : 'Required checks have not all passed for this candidate.') + '\n\n### Changed paths\n\n' + (value.changedPaths.length ? value.changedPaths.map(path => '- ' + cell(path)).join('\n') : 'No changed paths have been captured.') + '\n\n### Verification results\n\n| Check | Result | Exit code | Frozen check SHA-256 | Checked candidate SHA-256 | Finished |\n| --- | --- | --- | --- | --- | --- |\n' + rows + '\n\nCommand configuration and output remain in the worker. A passing check applies only to its recorded candidate and frozen command fingerprint; human review is still required.\n';
}
