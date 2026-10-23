import { developmentCompletionValid, developmentScopeView, validateDevelopmentState } from './development.js';
import { deliveryCheckDefinitionDigest } from './delivery-review.js';
import { deliveryVerificationEligibility } from './delivery-verification-eligibility.js';
import { validateDeliveryPolicySnapshot } from './delivery-policy.js';
import { sharedFeaturePublicationIssue } from './shared-feature-publication-limits.js';
import { fingerprint, type LocalTask } from './local-task-contracts.js';
import { gateDigest, type GateFactSnapshot, type WorkerRequest } from './request-gates.js';
import type { ModelResult } from './model-contract.js';
import type { RequestJournal } from './journal-ports.js';

/** A resumed candidate changes its gate projection, never its known provider result or observed facts. */
export function recordTaskResult(journal: RequestJournal, requestId: string, turnId: string, runId: string, result: ModelResult, facts: GateFactSnapshot) {
  const accepted = journal.get(requestId), execution = accepted.execution;
  if (!execution?.result) return journal.recordResult(requestId, turnId, runId, result, facts);
  if (execution.turnId !== turnId || execution.runId !== runId || execution.inputRevision !== accepted.inputRevision || gateDigest(execution.result) !== gateDigest(result))
    throw Error('Retained completion differs from its immutable execution result.');
  if (result.type === 'completed') journal.evaluate(requestId, 'done');
  return journal.get(requestId);
}

/** Restore an explicitly eligible packaged candidate without relabeling a failed check as passed. */
export function restorableDeliveryCompletion(task: LocalTask, request?: WorkerRequest): boolean {
  if (developmentCompletionValid(task)) return true;
  const { implementation: scope, developmentEvidence: evidence, developmentCompletion: receipt } = task;
  const run = request?.delivery, candidate = run?.review?.candidate;
  if (!request || !scope || !evidence || !receipt || !task.patch || !candidate || !run || run.status !== 'completed' || run.control || run.holds.length ||
      receipt.turnId !== task.currentTurnId || receipt.runId !== task.runId || request.execution?.turnId !== task.currentTurnId || request.execution.runId !== task.runId ||
      candidate.requestId !== request.id || candidate.runId !== run.id || candidate.inputRevision !== request.inputRevision || candidate.inputHash !== request.inputHash || candidate.policyDigest !== request.policyDigest) return false;
  try {
    validateDevelopmentState(scope, evidence);
    const context = request.input.context as { deliveryPolicy?: unknown; implementation?: unknown } | undefined;
    const policy = context?.deliveryPolicy ? validateDeliveryPolicySnapshot(context.deliveryPolicy) : undefined;
    if (gateDigest(developmentScopeView(scope)) !== gateDigest(context?.implementation) || candidate.baseline !== scope.baseCommit || candidate.checkDefinitionDigest !== deliveryCheckDefinitionDigest(scope) ||
        fingerprint(task.patch) !== receipt.patchSha256 || candidate.patchDigest !== receipt.patchSha256 || gateDigest(evidence) !== receipt.evidenceDigest ||
        receipt.candidateDigest !== evidence.candidateDigest || candidate.candidateDigest !== evidence.candidateDigest ||
        scope.sharedPublication && sharedFeaturePublicationIssue(task.patch, scope.sharedPublication) !== undefined) return false;
    return deliveryVerificationEligibility(scope, evidence, candidate, run.criterionDecisions, policy?.profile.exceptions).eligible;
  } catch { return false; }
}
