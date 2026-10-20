import { createHash } from 'node:crypto';
import { DomainError } from '../../shared/errors.js';
import { gateDigest } from './request-gates.js';
import { classifyDevelopmentEvidence } from './development-verification.js';
import type { DevelopmentScope } from './development.js';
import type { DeliveryCandidate, DeliveryHumanOutcome, DeliveryReviewInput, DeliveryReviewPackage } from './delivery-review-contracts.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const cell = (value: unknown) => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
const line = (value: string) => value.replace(/[\r\n]+/g, ' ');
export const deliveryCheckDefinitionDigest = (scope: DevelopmentScope) => gateDigest({ checks: scope.checks, verificationInputs: scope.verificationInputs ?? [] });
export function assertDeliverySubject(candidate: DeliveryCandidate, current: {
  inputRevision: number; inputHash: string; candidateDigest: string; policyDigest: string;
  baseline?: string; checkDefinitionDigest?: string; candidateCommit?: string;
}): void {
  const stale = candidate.inputRevision !== current.inputRevision || candidate.inputHash !== current.inputHash ||
    candidate.candidateDigest !== current.candidateDigest || candidate.policyDigest !== current.policyDigest ||
    current.baseline !== undefined && candidate.baseline !== current.baseline ||
    current.checkDefinitionDigest !== undefined && candidate.checkDefinitionDigest !== current.checkDefinitionDigest ||
    current.candidateCommit !== undefined && candidate.candidateCommit !== current.candidateCommit;
  if (stale) throw new DomainError('conflict', 'The review candidate or its requirements changed. Revalidate the current candidate before accepting it.');
}
/** A general approval cannot silently stand in for the request's individual manual checks. */
export function assertDeliveryAcceptance(review: DeliveryReviewPackage, current: {
  inputRevision: number; inputHash: string; candidateCommit: string; candidateDigest: string; policyDigest: string;
  humanOutcomes: DeliveryHumanOutcome[]; allowedExemptionIds?: string[];
}): void {
  if (typeof current.candidateCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(current.candidateCommit) || current.candidateCommit !== review.candidate.candidateCommit)
    throw new DomainError('conflict', 'Acceptance requires the exact current candidate commit.');
  assertDeliverySubject(review.candidate, current);
  const outcomes = current.humanOutcomes;
  if (!Array.isArray(outcomes) || outcomes.some(item => !item || typeof item !== 'object') || new Set(outcomes.map(item => item.criterionId)).size !== outcomes.length)
    throw new DomainError('invalid_input', 'Provide one explicit outcome for each mandatory human criterion.');
  for (const outcome of outcomes) {
    if (!review.criteria.some(item => item.id === outcome.criterionId && item.evaluator === 'human') ||
      !['passed', 'failed', 'exempted'].includes(outcome.outcome) || outcome.actor !== 'operator' ||
      typeof outcome.reason !== 'string' || !outcome.reason.trim() || outcome.reason.length > 4000 || !Number.isFinite(Date.parse(outcome.at)))
      throw new DomainError('invalid_input', 'Human review outcomes require a known criterion, an operator, a reason and a timestamp.');
  }
  for (const criterion of review.criteria.filter(item => item.mandatory)) {
    if (criterion.evaluator === 'check') {
      if (review.results.find(item => item.criterionId === criterion.id)?.status !== 'passed')
        throw new DomainError('conflict', 'Every mandatory automated criterion needs current passing evidence.');
      continue;
    }
    const outcome = outcomes.find(item => item.criterionId === criterion.id);
    if (!outcome || outcome.outcome !== 'passed' && !(outcome.outcome === 'exempted' && current.allowedExemptionIds?.includes(criterion.id)))
      throw new DomainError('conflict', 'Complete every mandatory human criterion before accepting this candidate.');
  }
}
/** Check outcomes come exclusively from worker receipts; prose criteria remain human-pending. */
export function buildDeliveryReview(input: DeliveryReviewInput): DeliveryReviewPackage {
  const { candidate, scope, evidence } = input;
  if (candidate.baseline !== scope.baseCommit || candidate.checkDefinitionDigest !== deliveryCheckDefinitionDigest(scope) ||
      candidate.candidateDigest !== evidence.candidateDigest || !classifyDevelopmentEvidence(scope, evidence).verified)
    throw new DomainError('conflict', 'Packaging requires current worker verification for this exact candidate and check definition.');
  const checks = evidence.checks.map(receipt => {
    const definition = scope.checks.find(item => item.id === receipt.presetId)!;
    return { ...structuredClone(receipt), evidenceRef: `check:${gateDigest(receipt)}`,
      command: { executable: definition.executable, args: [...definition.args] }, environment: { ...input.environment } };
  });
  const criteria = [
    ...scope.checks.map(check => ({ id: `check:${check.id}`, description: check.name, mandatory: true, evaluator: 'check' as const, checkId: check.id })),
    ...input.criteria.map((description, index) => ({ id: `human:${index + 1}:${digest(description).slice(0, 12)}`, description, mandatory: true, evaluator: 'human' as const })),
  ];
  const results = criteria.map(criterion => {
    if (criterion.evaluator === 'human') return { criterionId: criterion.id, status: 'pending_human' as const, evidenceRefs: [] };
    const check = checks.find(item => item.presetId === criterion.checkId);
    return { criterionId: criterion.id, status: check?.status === 'passed' ? 'passed' as const : 'unknown' as const,
      evidenceRefs: check ? [check.evidenceRef] : [] };
  });
  const review: DeliveryReviewPackage = { schemaVersion: 1, candidate: { ...candidate }, criteria, results, checks, markdown: '', publication: 'local_only' };
  const metadata = { type: 'PullRequest', status: 'in_review', featureRequestId: candidate.requestId, requestRevision: candidate.inputRevision,
    runId: candidate.runId, candidateCommit: candidate.candidateCommit, baseline: candidate.baseline, branch: candidate.branch, publication: 'local_only' };
  const rows = criteria.map(item => `| ${cell(item.id)} | ${cell(item.description)} | ${results.find(result => result.criterionId === item.id)!.status} | ${cell(results.find(result => result.criterionId === item.id)!.evidenceRefs.join(', '))} |`);
  review.markdown = `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n# Review: ${line(input.title)}\n\n` +
    `Local review package. No branch was pushed and no remote pull request was created. Human acceptance and merging remain separate actions.\n\n` +
    `## Candidate\n\n- Branch: \`${candidate.branch}\`\n- Commit: \`${candidate.candidateCommit}\`\n- Baseline: \`${candidate.baseline}\`\n- Tree: \`${candidate.tree}\`\n- Request revision: ${candidate.inputRevision}\n- Candidate digest: \`${candidate.candidateDigest}\`\n- Gate definition: \`${candidate.checkDefinitionDigest}\`\n\n` +
    `Inspect the exact change with \`git diff ${candidate.baseline} ${candidate.candidateCommit}\`.\n\n## Change summary\n\n${input.summary || 'No summary was returned.'}\n\n` +
    `## Approved scope\n\n${scope.approvedPaths.map(path => `- ${line(path)}`).join('\n')}\n\nChanges outside this scope were not authorized.\n\n` +
    `## Criteria and evidence\n\n| Criterion | Requirement | Result | Evidence |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n\n` +
    `## Check environment\n\n${checks.map(check => `- ${line(check.presetId)}: frozen command ${check.presetFingerprint}; exit ${check.exitCode}; ${check.finishedAt}; ${cell(check.environment.platform)}/${cell(check.environment.architecture)}; Node ${cell(check.environment.nodeVersion)}; ${check.evidenceRef}`).join('\n')}\n\n` +
    `## Human review\n\n${criteria.filter(item => item.evaluator === 'human').map(item => `- [ ] ${line(item.description)} (${item.id})`).join('\n') || 'Inspect the implementation and automated evidence.'}\n\nRecord each manual outcome explicitly against this candidate commit. A general approval does not complete pending human criteria.\n\n` +
    `## Proposed pull request\n\nTitle: ${line(input.title)}\n\n${input.summary || 'Review the candidate diff and evidence above.'}\n\n## Limitations\n\nOnly the configured checks are verified. Manual criteria remain pending until a person records their outcomes. This note is stored outside the tested workspace. Command arguments and raw check output remain in private worker evidence.\n`;
  return review;
}
