import type { DevelopmentEvidence, DevelopmentScopeView } from './development.js';
export function compareBaselineChecks(scope: DevelopmentScopeView, evidence?: DevelopmentEvidence) {
  const baseline = evidence?.baseline;
  return scope.checks.map(check => {
    const prior = baseline?.checks.find(item => item.presetId === check.id && item.presetFingerprint === check.fingerprint);
    const current = evidence?.checks.find(item => item.presetId === check.id && item.presetFingerprint === check.fingerprint && item.candidateDigest === evidence.candidateDigest);
    const knownPrior = baseline?.status === 'observed' && !!prior && prior.status !== 'interrupted' && prior?.exitCode !== null;
    const knownCurrent = current && current.status !== 'interrupted' && current.exitCode !== null;
    const classification = !knownPrior || !knownCurrent ? 'unknown' : prior?.status === 'passed' ? current.status === 'passed' ? 'passing' : 'regression' : current.status === 'passed' ? 'resolved' : 'pre_existing';
    return { id: check.id, name: check.name, classification, baselineStatus: prior?.status ?? 'not_run', candidateStatus: current?.status ?? 'not_run' };
  });
}
