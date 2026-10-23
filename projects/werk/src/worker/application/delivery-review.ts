import { parseDeliveryAssessment } from './delivery-provider-contracts.js';
import { validateDevelopmentBaseline } from './development-baseline.js';
import { compareBaselineChecks } from './development-baseline-comparison.js';
import { deliveryCriterionDecision, type DeliveryCriterionDecision, type DeliveryCriterionExceptionPolicy } from './delivery-criterion-decisions.js';
import { createHash } from 'node:crypto';
import { DomainError } from '../../shared/errors.js';
import { gateDigest } from './request-gates.js';
import { deliveryVerificationEligibility } from './delivery-verification-eligibility.js';
import type { DevelopmentScope } from './development.js';
import type { DeliveryCandidate, DeliveryHumanOutcome, DeliveryReviewInput, DeliveryReviewPackage } from './delivery-review-contracts.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const cell = (value: unknown) => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
const line = (value: string) => value.replace(/[\r\n]+/g, ' ');
export const deliveryCheckDefinitionDigest = (scope: DevelopmentScope) => gateDigest({ checks: scope.checks, verificationInputs: scope.verificationInputs ?? [], ...(scope.checkPacks ? { checkPacks: scope.checkPacks } : {}) });
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
  humanOutcomes: DeliveryHumanOutcome[]; criterionDecisions?: DeliveryCriterionDecision[]; exceptionPolicy?: DeliveryCriterionExceptionPolicy;
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
    const decision = deliveryCriterionDecision(criterion.id, review.candidate, current.criterionDecisions, current.exceptionPolicy);
    if (criterion.evaluator === 'check') {
      if (review.results.find(item => item.criterionId === criterion.id)?.status !== 'passed' && !decision)
        throw new DomainError('conflict', 'Every mandatory automated criterion needs current passing evidence.');
      continue;
    }
    const outcome = outcomes.find(item => item.criterionId === criterion.id);
    if (!decision && outcome?.outcome !== 'passed')
      throw new DomainError('conflict', 'Complete every mandatory human criterion before accepting this candidate.');
  }
}
/** Check outcomes come exclusively from worker receipts; prose criteria remain human-pending. */
export function buildDeliveryReview(input: DeliveryReviewInput): DeliveryReviewPackage {
  const { candidate, scope, evidence } = input;
  const effective = deliveryVerificationEligibility(scope, evidence, candidate, input.criterionDecisions, input.exceptionPolicy).eligible;
  if (candidate.baseline !== scope.baseCommit || candidate.checkDefinitionDigest !== deliveryCheckDefinitionDigest(scope) ||
      candidate.candidateDigest !== evidence.candidateDigest || !effective)
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
    if (criterion.evaluator === 'human') {
      const decision = deliveryCriterionDecision(criterion.id, candidate, input.criterionDecisions, input.exceptionPolicy);
      return { criterionId: criterion.id, status: decision?.kind === 'not_applicable' ? 'not_applicable' as const : 'pending_human' as const, evidenceRefs: [], ...(decision ? { observedStatus: 'pending_human' as const, decisionRef: 'decision:' + gateDigest(decision) } : {}) };
    }
    const check = checks.find(item => item.presetId === criterion.checkId);
    const status = check?.status === 'passed' && check.exitCode === 0 ? 'passed' as const : check?.status === 'failed' && check.exitCode !== null ? 'failed' as const : 'unknown' as const;
    const decision = deliveryCriterionDecision(criterion.id, candidate, input.criterionDecisions, input.exceptionPolicy);
    return { criterionId: criterion.id, status: decision?.kind === 'not_applicable' ? 'not_applicable' as const : status,
      evidenceRefs: check ? [check.evidenceRef] : [], ...(decision ? { observedStatus: status, decisionRef: 'decision:' + gateDigest(decision) } : {}) };
  });
  const decisions = criteria.flatMap(criterion => { const decision = deliveryCriterionDecision(criterion.id, candidate, input.criterionDecisions, input.exceptionPolicy); return decision ? [structuredClone(decision)] : []; });
  let baseline: DeliveryReviewPackage['baseline'];
  if (evidence.baseline) {
    validateDevelopmentBaseline(scope, evidence.baseline);
    const { checks: priorChecks, retainedWorktree: _retainedWorktree, ...observation } = evidence.baseline;
    baseline = { ...observation, checks: priorChecks.map(({ stdout, stderr, ...check }) => ({ ...check, stdoutDigest: digest(stdout), stderrDigest: digest(stderr) })) };
  }
  const baselineComparison = compareBaselineChecks(scope, evidence);
  if ((input.assessments?.length ?? 0) > 64) throw new DomainError('conflict', 'The retained assessment history exceeds its review bound.');
  const assessments = (input.assessments ?? []).filter(item => item.candidate.requestId === candidate.requestId && item.candidate.runId === candidate.runId && item.candidate.inputRevision === candidate.inputRevision && item.candidate.inputHash === candidate.inputHash && item.candidate.policyDigest === candidate.policyDigest && item.candidate.baseline === candidate.baseline && item.candidate.candidateCommit === candidate.candidateCommit && item.candidate.candidateDigest === candidate.candidateDigest && item.candidate.checkDefinitionDigest === candidate.checkDefinitionDigest && item.evidenceDigest === gateDigest(evidence)).map(item => {
    const parsed = parseDeliveryAssessment(JSON.stringify({ summary: item.summary, findings: item.findings }));
    if (item.passed !== !parsed.findings.some(finding => finding.severity === 'blocking') || !Number.isFinite(Date.parse(item.at))) throw new DomainError('conflict', 'Candidate assessment provenance is invalid.');
    return { ...structuredClone(item), ...parsed };
  });
  const review: DeliveryReviewPackage = { schemaVersion: 1, ...(assessments.length ? { assessments } : {}), ...(input.requestDetails ? { requestDetails: structuredClone(input.requestDetails) } : {}), ...(baseline ? { baseline } : {}), baselineComparison, candidate: { ...candidate }, criteria, results, checks, ...(decisions.length ? { criterionDecisions: decisions } : {}), markdown: '', publication: 'local_only' };
  const metadata = { type: 'PullRequest', status: 'in_review', featureRequestId: candidate.requestId, requestRevision: candidate.inputRevision,
    runId: candidate.runId, candidateCommit: candidate.candidateCommit, baseline: candidate.baseline, branch: candidate.branch, publication: 'local_only' };
  const rows = criteria.map(item => `| ${cell(item.id)} | ${cell(item.description)} | ${results.find(result => result.criterionId === item.id)!.status} | ${cell(results.find(result => result.criterionId === item.id)!.evidenceRefs.join(', '))} |`);
  review.markdown = `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n# Review: ${line(input.title)}\n\n` +
    `Local review package. No branch was pushed and no remote pull request was created. Human acceptance and merging remain separate actions.\n\n` +
    (input.requestDetails ? `## Requested outcome\n\nFeature Request: ${line(input.requestDetails.featureId ?? candidate.requestId)}\nCanonical source: ${line(input.requestDetails.sourcePath ?? 'Retained worker request')}\n\n${input.requestDetails.requestedOutcome}\n\n## Accepted readiness supplements\n\n${input.requestDetails.readinessSupplements.map(item => `- ${line(item.id)} (${item.kind}, ${item.status}): ${line(item.text)}${item.reason ? ` — ${line(item.reason)}` : ''}`).join('\n') || 'No additional assumptions or interpretations were adopted.'}\n\n${input.requestDetails.plan ? `## Retained implementation plan\n\n${input.requestDetails.plan.steps.map(item => `- ${line(item.title)} Required checks: ${item.verification.join(', ') || 'None in this step'}.`).join('\n')}\n\n` : ''}` : '') +
    `## Candidate\n\n- Branch: \`${candidate.branch}\`\n- Commit: \`${candidate.candidateCommit}\`\n- Baseline: \`${candidate.baseline}\`\n- Tree: \`${candidate.tree}\`\n- Request revision: ${candidate.inputRevision}\n- Candidate digest: \`${candidate.candidateDigest}\`\n- Gate definition: \`${candidate.checkDefinitionDigest}\`\n\n` +
    `Inspect the exact change with \`git diff ${candidate.baseline} ${candidate.candidateCommit}\`.\n\n## Model-reported implementation summary\n\n${input.summary || 'No summary was returned.'}\n\n` +
    `## Approved scope\n\n${scope.approvedPaths.map(path => `- ${line(path)}`).join('\n')}\n\nExcluded work: changes outside the approved paths and the accepted request boundaries are not authorized. Material deviations are not separately classified by this package; compare the retained requested outcome, provider summary and exact diff before acceptance.\n\n` +
    `## Criteria and evidence\n\n| Criterion | Requirement | Result | Evidence |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n\n` +
    `## Check environment\n\n${checks.map(check => `- ${line(check.presetId)}: frozen command ${check.presetFingerprint}; exit ${check.exitCode}; ${check.finishedAt}; ${cell(check.environment.platform)}/${cell(check.environment.architecture)}; Node ${cell(check.environment.nodeVersion)}; ${check.evidenceRef}`).join('\n')}\n\n` +
    (decisions.length ? `## Authorized criterion decisions\n\n${decisions.map(decision => `- ${line(decision.criterionId)}: ${decision.kind} by ${decision.actor} at ${decision.at}. ${line(decision.reason)} (request revision ${decision.subject.inputRevision}, candidate ${decision.subject.candidateCommit}, decision:${gateDigest(decision)}). Actual check observations above remain unchanged.`).join('\n')}\n\n` : '') +
    (assessments.length ? `## Model candidate assessment\n\n${assessments.map(item => `Profile ${line(item.profileId)}; invocation ${line(item.invocationRunId)}; ${item.at}; candidate ${item.candidate.candidateCommit}; dispatch ${item.dispatchDigest}.\n\n${item.summary}\n\n${item.findings.map(finding => `- ${finding.id} (${finding.severity}): ${line(finding.message)}`).join('\n') || 'No reviewer findings.'}`).join('\n\n')}\n\nModel judgment does not replace deterministic check evidence.\n\n` : '') +
    `## Baseline comparison\n\n${baseline ? `Baseline ${baseline.baseline}: ${baseline.status}; observed ${baseline.observedAt}. ${baseline.reason ?? ''}` : 'No baseline check observations are available.'}\n\n${baselineComparison.map(item => `- ${line(item.id)}: ${item.classification} (baseline ${item.baselineStatus}; candidate ${item.candidateStatus}).`).join('\n')}\n\nA pre-existing failure is diagnostic evidence, not a passing check or an exception.\n\n` +
    `## Human review\n\n${criteria.filter(item => item.evaluator === 'human').map(item => `- [ ] ${line(item.description)} (${item.id})`).join('\n') || 'Inspect the implementation and automated evidence.'}\n\nRecord each manual outcome explicitly against this candidate commit. A general approval does not complete pending human criteria.\n\n` +
    `## Proposed pull request\n\nTitle: ${line(input.title)}\n\n${input.summary || 'Review the candidate diff and evidence above.'}\n\n## Limitations\n\nCheck results describe only the configured observations. Authorized exceptions are disclosed separately and never change a failed observation into a pass. Manual criteria remain pending until an explicit outcome or policy-permitted criterion decision is recorded. This note is stored outside the tested workspace. Command arguments and raw check output remain in private worker evidence.\n`;
  return review;
}
