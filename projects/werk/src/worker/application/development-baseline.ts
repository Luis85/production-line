import { DomainError } from '../../shared/errors.js';
import { gateDigest } from './request-gates.js';
import type { DevelopmentCheckEvidence, DevelopmentScopeView } from './development.js';
/** Separate observations of unchanged committed input; failures never exempt candidate checks. */
export interface DevelopmentBaselineEvidence {
  schemaVersion: 1; baseline: string; checkDefinitionDigest: string; checks: DevelopmentCheckEvidence[];
  observedAt: string; sourceDigest?: string; status: 'observed' | 'unavailable'; reason?: string; retainedWorktree?: string;
}
export const baselineCheckDigest = (scope: DevelopmentScopeView) => scope.checkPacks ? gateDigest({ checks: scope.checks.map(check => ({ id: check.id, fingerprint: check.fingerprint })), checkPacks: scope.checkPacks }) : gateDigest(scope.checks.map(check => ({ id: check.id, fingerprint: check.fingerprint })));
export function validateDevelopmentBaseline(scope: DevelopmentScopeView, value: unknown): asserts value is DevelopmentBaselineEvidence {
  const raw = value as DevelopmentBaselineEvidence | undefined;
  if (!raw || raw.schemaVersion !== 1 || raw.baseline !== scope.baseCommit || raw.checkDefinitionDigest !== baselineCheckDigest(scope) || !['observed', 'unavailable'].includes(raw.status) || !Number.isFinite(Date.parse(raw.observedAt)) || !Array.isArray(raw.checks) || raw.checks.length > scope.checks.length || new Set(raw.checks.map(check => check?.presetId)).size !== raw.checks.length || raw.reason !== undefined && (typeof raw.reason !== 'string' || raw.reason.length > 2000) || raw.retainedWorktree !== undefined && (typeof raw.retainedWorktree !== 'string' || raw.retainedWorktree.length > 4096)) throw new DomainError('conflict', 'Saved baseline check observations no longer match the accepted verification plan.');
  for (const check of raw.checks) if (!check || !scope.checks.some(required => required.id === check.presetId && required.fingerprint === check.presetFingerprint) || !/^[a-f0-9]{64}$/.test(check.candidateDigest) || !['passed', 'failed', 'interrupted'].includes(check.status) || check.exitCode !== null && !Number.isSafeInteger(check.exitCode) || check.status === 'passed' && check.exitCode !== 0 || typeof check.stdout !== 'string' || typeof check.stderr !== 'string' || check.stdout.length > 32768 || check.stderr.length > 32768 || !Number.isFinite(Date.parse(check.startedAt)) || !Number.isFinite(Date.parse(check.finishedAt))) throw new DomainError('conflict', 'Invalid saved baseline check receipt.');
  if (raw.status === 'observed' && (raw.checks.length !== scope.checks.length || !/^[a-f0-9]{64}$/.test(raw.sourceDigest ?? '') || raw.checks.some(check => check.candidateDigest !== raw.sourceDigest))) throw new DomainError('conflict', 'An observed baseline requires every configured check.');
}
