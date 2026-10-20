import { DomainError } from '../../shared/errors.js';
import { object, text } from '../../shared/contracts.js';
import { featureWorkflowPath } from './feature-workflow.js';

export interface DeliveryReadinessPolicy {
  assessment: 'required';
  assumptions: 'explicit' | 'allow_low_impact';
  requiredReferences: string[];
  maxEstimatedMinutes: number | null;
}
export type DeliveryReadinessCondition = 'outcome' | 'criteria' | 'scope';
export interface DeliveryReadinessProposal {
  id: string; kind: 'interpretation' | 'assumption' | 'decomposition'; text: string;
  impact: 'low' | 'material'; blockingQuestionIds: string[];
}
export interface DeliveryReadinessResult {
  conditions: { id: DeliveryReadinessCondition; outcome: 'pass' | 'fail' | 'unknown'; reason: string }[];
  estimatedMinutes: number | null;
  proposals: DeliveryReadinessProposal[];
}
export interface DeliveryReadinessSubject { inputRevision: number; inputHash: string; policyDigest: string; }
export interface DeliveryReadinessAssessment extends DeliveryReadinessSubject {
  id: string; evaluator: { kind: 'model' | 'operator'; id: string }; at: string;
  result: DeliveryReadinessResult;
}
export interface DeliveryReadinessDecision extends DeliveryReadinessSubject {
  operationId: string; assessmentId: string; proposalId: string;
  outcome: 'accepted' | 'rejected'; actor: 'operator'; reason: string; at: string;
}
export interface DeliveryReadinessReference {
  path: string; baseline: string; status: 'available' | 'missing' | 'inaccessible';
  reason: string; sha256?: string; observedAt: string;
}
export interface DeliveryReadinessState {
  assessments: DeliveryReadinessAssessment[];
  decisions: DeliveryReadinessDecision[];
}
function invalid(message: string): never { throw new DomainError('invalid_input', message); }
function conflict(message: string): never { throw new DomainError('conflict', message); }
const ids = ['outcome', 'criteria', 'scope'] as const;
const identifier = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const current = (value: DeliveryReadinessSubject, subject: DeliveryReadinessSubject) => value.inputRevision === subject.inputRevision && value.inputHash === subject.inputHash && value.policyDigest === subject.policyDigest;

export function validateDeliveryReadinessPolicy(value: unknown): DeliveryReadinessPolicy {
  const raw = object(value, 'Readiness policy', ['assessment', 'assumptions', 'requiredReferences', 'maxEstimatedMinutes']);
  if (raw.assessment !== 'required' || typeof raw.assumptions !== 'string' || !['explicit', 'allow_low_impact'].includes(raw.assumptions) ||
    !Array.isArray(raw.requiredReferences) || raw.requiredReferences.length > 32 ||
    raw.maxEstimatedMinutes !== null && (!Number.isSafeInteger(raw.maxEstimatedMinutes) || Number(raw.maxEstimatedMinutes) < 1 || Number(raw.maxEstimatedMinutes) > 10080)) invalid('Readiness requires a structured assessment, explicit assumption policy, at most 32 references and a bounded duration or null.');
  const requiredReferences = (raw.requiredReferences as unknown[]).map(path => featureWorkflowPath(path, 'Required readiness reference'));
  if (new Set(requiredReferences.map(path => path.toLowerCase())).size !== requiredReferences.length) invalid('Required readiness references must be unique, including on case-insensitive filesystems.');
  return { assessment: 'required', assumptions: raw.assumptions as DeliveryReadinessPolicy['assumptions'], requiredReferences, maxEstimatedMinutes: raw.maxEstimatedMinutes as number | null };
}
/** Semantic judgments have their own provenance and cannot claim file, tool or verification observations. */
export function validateDeliveryReadinessResult(value: unknown): DeliveryReadinessResult {
  const raw = object(value, 'Structured readiness assessment', ['conditions', 'estimatedMinutes', 'proposals']);
  if (!Array.isArray(raw.conditions) || raw.conditions.length !== ids.length || !Array.isArray(raw.proposals) || raw.proposals.length > 16 ||
    raw.estimatedMinutes !== null && (!Number.isSafeInteger(raw.estimatedMinutes) || Number(raw.estimatedMinutes) < 1 || Number(raw.estimatedMinutes) > 10080)) invalid('Provide outcome, criteria and scope judgments, a bounded estimate or null, and at most 16 proposals.');
  const conditions = raw.conditions.map(value => {
    const item = object(value, 'Readiness condition', ['id', 'outcome', 'reason']);
    if (!ids.includes(item.id as DeliveryReadinessCondition) || typeof item.outcome !== 'string' || !['pass', 'fail', 'unknown'].includes(item.outcome)) invalid('Use documented semantic readiness conditions and pass, fail or unknown.');
    return { id: item.id as DeliveryReadinessCondition, outcome: item.outcome as 'pass' | 'fail' | 'unknown', reason: text(item.reason, 'Assessment reason', 2000) };
  });
  if (new Set(conditions.map(item => item.id)).size !== ids.length) invalid('Every semantic readiness condition must occur exactly once.');
  const proposals = raw.proposals.map(value => {
    const item = object(value, 'Readiness proposal', ['id', 'kind', 'text', 'impact', 'blockingQuestionIds']);
    if (!identifier(item.id) || typeof item.kind !== 'string' || !['interpretation', 'assumption', 'decomposition'].includes(item.kind) || typeof item.impact !== 'string' || !['low', 'material'].includes(item.impact) ||
      !Array.isArray(item.blockingQuestionIds) || item.blockingQuestionIds.length > 32 || item.blockingQuestionIds.some(value => !identifier(value)) || new Set(item.blockingQuestionIds).size !== item.blockingQuestionIds.length) invalid('A proposal needs a stable ID, supported kind, impact and explicit blocking-question IDs.');
    return { id: item.id as string, kind: item.kind as DeliveryReadinessProposal['kind'], text: text(item.text, 'Proposal text', 4000), impact: item.impact as 'low' | 'material', blockingQuestionIds: [...item.blockingQuestionIds] as string[] };
  });
  if (new Set(proposals.map(item => item.id)).size !== proposals.length) invalid('Readiness proposal IDs must be unique.');
  return { conditions, estimatedMinutes: raw.estimatedMinutes as number | null, proposals };
}
export function readinessAssessment(result: unknown, subject: DeliveryReadinessSubject, evaluator: DeliveryReadinessAssessment['evaluator'], id: string, at: string): DeliveryReadinessAssessment {
  if (!identifier(id) || !identifier(evaluator.id) || !['model', 'operator'].includes(evaluator.kind) || typeof at !== 'string' || !Number.isFinite(Date.parse(at)) ||
    !Number.isSafeInteger(subject.inputRevision) || subject.inputRevision < 1 || typeof subject.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(subject.inputHash) || typeof subject.policyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(subject.policyDigest)) invalid('Readiness assessment requires exact input/policy identity and attributable evaluator.');
  return { inputRevision: subject.inputRevision, inputHash: subject.inputHash, policyDigest: subject.policyDigest, id, evaluator: { ...evaluator }, at, result: validateDeliveryReadinessResult(result) };
}
export function decideReadinessProposal(state: DeliveryReadinessState, subject: DeliveryReadinessSubject, input: {
  assessmentId: string; proposalId: string; outcome: 'accepted' | 'rejected'; reason: string; operationId: string;
}, at: string): DeliveryReadinessDecision {
  const assessment = state.assessments.findLast(value => current(value, subject));
  const proposal = assessment?.result.proposals.find(value => value.id === input.proposalId);
  if (!assessment || assessment.id !== input.assessmentId || !proposal) conflict('The proposed interpretation belongs to an earlier assessment. Refresh the current request.');
  if (!['accepted', 'rejected'].includes(input.outcome) || !identifier(input.operationId) || typeof at !== 'string' || !Number.isFinite(Date.parse(at))) invalid('A readiness decision requires a stable command, outcome and timestamp.');
  // A proposal can supplement accepted intent; it can never answer another question by implication.
  if (input.outcome === 'accepted' && proposal.blockingQuestionIds.length) conflict('Answer the identified blocking questions and reassess before adopting this proposal.');
  return { inputRevision: subject.inputRevision, inputHash: subject.inputHash, policyDigest: subject.policyDigest, operationId: input.operationId, assessmentId: assessment.id, proposalId: proposal.id,
    outcome: input.outcome, actor: 'operator', reason: text(input.reason, 'Readiness decision reason', 4000), at };
}
export function deliveryReadinessView(policy: DeliveryReadinessPolicy | undefined, subject: DeliveryReadinessSubject, state?: DeliveryReadinessState, references: readonly DeliveryReadinessReference[] = [], baseline?: string) {
  const assessment = state?.assessments.findLast(value => current(value, subject));
  if (!policy) return { configured: false, passed: true, assessment, conditions: [], proposals: [], message: 'This retained profile has no structured semantic readiness assessment.' };
  policy = validateDeliveryReadinessPolicy(policy);
  const conditions: { id: string; outcome: 'pass' | 'fail' | 'unknown'; reason: string }[] = ids.map(id => assessment?.result.conditions.find(item => item.id === id) ?? { id, outcome: 'unknown', reason: 'A structured assessment of ' + id + ' is required for this request revision.' });
  for (const path of policy.requiredReferences) {
    const reference = references.find(item => item.path === path && item.baseline === baseline);
    const available = reference?.status === 'available' && typeof reference.sha256 === 'string' && /^[a-f0-9]{64}$/.test(reference.sha256) && typeof reference.observedAt === 'string' && Number.isFinite(Date.parse(reference.observedAt));
    conditions.push({ id: 'reference:' + path, outcome: available ? 'pass' : reference?.status === 'missing' ? 'fail' : 'unknown', reason: reference?.reason ?? 'The worker has not inspected this required reference at the accepted baseline.' });
  }
  if (policy.maxEstimatedMinutes !== null) {
    const estimate = assessment?.result.estimatedMinutes;
    conditions.push({ id: 'scope_limit', outcome: estimate == null ? 'unknown' : estimate <= policy.maxEstimatedMinutes ? 'pass' : 'fail', reason: estimate == null ? 'Estimate the task before dispatch or propose a bounded decomposition.' : estimate <= policy.maxEstimatedMinutes ? 'The assessed scope fits the configured estimate limit; runtime limits still apply.' : 'The assessed scope exceeds the configured limit. Split the request into bounded dependent requests or obtain a new authorized profile.' });
  }
  const proposals = (assessment?.result.proposals ?? []).map(proposal => {
    const decision = state?.decisions.findLast(value => current(value, subject) && value.assessmentId === assessment!.id && value.proposalId === proposal.id);
    const permitted = !decision && policy.assumptions === 'allow_low_impact' && proposal.kind === 'assumption' && proposal.impact === 'low' && !proposal.blockingQuestionIds.length;
    return { ...proposal, status: decision?.outcome ?? (permitted ? 'policy_permitted' : 'proposed'), decision: decision ?? null };
  });
  // No proposal, including a policy-permitted assumption, can replace a failed semantic condition.
  return { configured: true, passed: conditions.every(item => item.outcome === 'pass'), assessment, conditions, proposals, message: 'Structured judgments, worker reference observations and explicit decisions remain distinct.' };
}
export const readinessProtocol = 'When structured readiness is configured, also return "readiness":{"conditions":[{"id":"outcome|criteria|scope","outcome":"pass|fail|unknown","reason":"specific supporting reason"}],"estimatedMinutes":null,"proposals":[{"id":"stable-id","kind":"interpretation|assumption|decomposition","text":"proposed wording only","impact":"low|material","blockingQuestionIds":[]}]}. Include each condition exactly once. Never invent an answer; use unknown and an actionable finding when a material decision is missing. Reference inspection, permissions, budgets and deterministic checks are worker observations, not model judgments. Estimates are estimates, not promised completion times.';

export function validateDeliveryReadinessReferences(value: unknown): DeliveryReadinessReference[] {
  if (!Array.isArray(value) || value.length > 32) invalid('Retain at most 32 worker reference observations.');
  const references = value.map(value => {
    const item = object(value, 'Readiness reference observation', ['path', 'baseline', 'status', 'reason', 'sha256', 'observedAt']);
    const path = featureWorkflowPath(item.path, 'Readiness reference');
    if (typeof item.baseline !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(item.baseline) ||
      typeof item.status !== 'string' || !['available', 'missing', 'inaccessible'].includes(item.status) || typeof item.observedAt !== 'string' || !Number.isFinite(Date.parse(item.observedAt)) ||
      (item.status === 'available' ? typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) : item.sha256 !== undefined)) invalid('Reference observations require baseline, known availability, timestamp and a content digest only when available.');
    return { path, baseline: item.baseline, status: item.status as DeliveryReadinessReference['status'], reason: text(item.reason, 'Reference observation reason', 2000), observedAt: item.observedAt, ...(item.sha256 === undefined ? {} : { sha256: item.sha256 as string }) };
  });
  if (new Set(references.map(item => item.path.toLowerCase())).size !== references.length) invalid('Retained reference observations must use unique paths.');
  return references;
}
