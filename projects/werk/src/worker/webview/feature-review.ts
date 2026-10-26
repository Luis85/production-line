import type { GateEvaluation, GateStage, WorkerRequest } from '../application/request-gates';
import type { InteractionView } from '../application/interactions';
import type { LocalTaskDetailView, LocalTaskSummaryView, SessionView } from '../application/workspace-view';
import type { SharedFeatureView } from '../application/shared-intake-contract';
import { sharedReadyReviewView } from './shared-ready-review-view';
import { candidateEvidenceView } from './candidate-evidence';
import { deliveryNextStep } from './delivery-view';
import { deliveryReviewStages } from './delivery-review-stages';
import { currentWorkflowAcceptance, workflowReleaseNextStep, workflowLocalMergeNextStep } from './workflow-timeline';

export interface FeatureReviewInput {
  session?: SessionView['records'][number] | null;
  task?: LocalTaskDetailView | LocalTaskSummaryView | null;
  request?: WorkerRequest | null;
  interaction?: InteractionView | null;
  shared?: SharedFeatureView | null;
  freshness?: { stale: boolean; error?: string; readAt?: string | null };
}
interface FeatureReviewStage {
  id: 'readiness' | 'execution' | 'verification' | 'handoff';
  label: string;
  state: 'pending' | 'active' | 'complete' | 'blocked' | 'unknown';
  detail: string;
}
type FeatureReviewAction = 'refresh' | 'answer' | 'resume' | 'inspect_checks' | 'review_request' | 'attest' | 'review_patch' | 'review_shared' | 'open_source' | 'inspect_history' | 'delivery_controls';
interface FeatureReviewNextStep {
  actor: 'operator' | 'worker' | 'owning_worker' | 'orchestrator';
  title: string;
  description: string;
  /** Navigation to existing controls, never authorization to execute a command. */
  action?: { kind: FeatureReviewAction; label: string };
}
/** Evidence is current only for the accepted input, frozen policy and recorded output. */
export function currentRequestEvaluation(request: WorkerRequest | null | undefined, stage: GateStage): GateEvaluation | undefined {
  if (!request) return;
  return request.evaluations.findLast(evaluation => evaluation.stage === stage &&
    evaluation.inputRevision === request.inputRevision && evaluation.inputHash === request.inputHash &&
    evaluation.policyDigest === request.policyDigest &&
    (stage === 'ready' || !!request.execution?.outputDigest && request.execution.inputRevision === request.inputRevision && evaluation.outputDigest === request.execution.outputDigest));
}
function identityConflict(input: FeatureReviewInput): boolean {
  const { session, task, request, interaction, shared } = input;
  const references = [session?.feature, task?.feature, shared?.feature].filter(value => !!value);
  const sessionIds = [session?.id, task?.sessionId, request?.owner.sessionId, interaction?.sessionId].filter(value => !!value);
  return !!(shared && !shared.isLocal && (session || task || request || interaction)) ||
    !!(session?.kind === 'local' && task && session.taskId !== task.id && !(session.taskId === session.id && task.sessionId === session.id)) ||
    new Set(references.map(value => value.key)).size > 1 || new Set(sessionIds).size > 1 ||
    !!(task && request && (task.requestId && task.requestId !== request.id || request.owner.taskId && request.owner.taskId !== task.id)) ||
    !!(shared?.taskId && task && shared.taskId !== task.id);
}
const next = (actor: FeatureReviewNextStep['actor'], title: string, description: string, kind?: FeatureReviewAction, label?: string): FeatureReviewNextStep =>
  ({ actor, title, description, ...(kind ? { action: { kind, label: label ?? title } } : {}) });
function gateStage(id: 'readiness' | 'verification', label: string, evaluation: GateEvaluation | null): FeatureReviewStage {
  return { id, label, state: !evaluation ? 'unknown' : evaluation.passed ? 'complete' : 'blocked',
    detail: !evaluation ? 'Not evaluated for the current input and evidence.' : evaluation.passed ? 'Recorded checks passed.' : evaluation.rules.some(rule => rule.result === 'unknown') ? 'Required evidence is unknown; the gate remains blocked.' : 'Recorded checks have not passed.' };
}
/** A projection of existing authorities. It never advances a phase or creates another workflow. */
export function buildFeatureReviewView(input: FeatureReviewInput) {
  const conflict = identityConflict(input);
  const { session, task, request, shared } = conflict ? {} : input;
  const interaction = conflict ? undefined : input.interaction ?? task?.interaction ?? session?.interaction;
  const feature = session?.feature ?? task?.feature ?? shared?.feature;
  const unavailable = !session && !task && !request && !shared;
  const stale = conflict || unavailable || !!input.freshness?.stale || !!input.freshness?.error;
  const sharedSource = feature?.source === 'shared_git' || !!shared;
  const remote = feature?.source === 'orchestrator' || session?.kind === 'orchestrator' || !!request?.owner.remote;
  const otherOwner = !!shared && !shared.isLocal && !!shared.owner;
  const unclaimed = !!shared && !shared.isLocal && !shared.owner;
  const kind = otherOwner ? 'shared_other' as const : unclaimed ? 'shared_unclaimed' as const : sharedSource ? 'shared_local' as const : remote ? 'orchestrator' as const : 'local' as const;
  const ownership = { kind, label: otherOwner ? 'Another worker owns this request' : unclaimed ? 'Shared request awaiting ownership' : sharedSource ? 'Shared request owned by this worker' : remote ? 'Assignment owned by the orchestrator' : 'Request on this worker',
    scopeMutable: !sharedSource && !remote && !stale, readOnly: stale || otherOwner || unclaimed };
  const ready = currentRequestEvaluation(request, 'ready') ?? null, done = currentRequestEvaluation(request, 'done') ?? null;
  const candidate = task ? candidateEvidenceView(task) : null;
  const deliveryView = request?.delivery ? deliveryReviewStages(request) : null;
  const hasPatch = !!task && ('patch' in task ? !!task.patch : task.hasPatch);
  const openFindings = request?.findings.filter(finding => finding.status === 'open') ?? [];
  const blockingFindingCount = openFindings.filter(finding => finding.blocking).length;
  const attestationRequired = !!request?.delivery?.review || !!request?.policy.done[request.input.kind].some(rule => rule.fact === 'operator.accepted' && (rule.op === 'eq' && rule.value === true || rule.op === 'neq' && rule.value === false));
  const acceptanceRules = done?.rules.filter(rule => rule.result !== 'pass') ?? [];
  const acceptanceOnly = acceptanceRules.length > 0 && acceptanceRules.every(rule => rule.fact === 'operator.accepted') &&
    openFindings.filter(finding => finding.blocking).every(finding => finding.source === 'deterministic' && finding.evaluationId === done?.id && acceptanceRules.some(rule => rule.ruleId === finding.ruleId));
  const attested = (!request?.delivery || currentWorkflowAcceptance(request)) && !!request?.attestation && request.attestation.inputHash === request.inputHash && !!request.execution?.outputDigest && request.attestation.outputDigest === request.execution.outputDigest;
  const activeReview = request?.reviews.some(review => ['queued', 'running'].includes(review.status)) ?? false;
  const status = interaction?.phase && interaction.phase !== 'idle' ? interaction.phase : task?.status ?? session?.status ?? request?.phase ?? shared?.status ?? 'unknown';
  const activeExecution = ['queued', 'running'].includes(status) || !!request?.execution && ['prepared', 'running'].includes(request.execution.status);
  const pending = interaction?.pending;
  const continuationBlocked = session?.continuationBlockedReason ?? (task?.admissionFailure ? task.error || 'Approved file snapshots were not retained.' : null);
  const response = shared?.taskResponse;
  const responsePending = !!response && !!interaction && response.sessionId === interaction.sessionId &&
    response.expectedRevision === interaction.revision && response.pendingId === (pending?.id ?? null) &&
    response.turnId === (pending?.turnId ?? interaction.latestTurn?.id) && ['publication_pending', 'ready'].includes(response.status);
  const title = request?.input.title || session?.title || task?.title || shared?.title || 'Feature Request';
  const readiness = gateStage('readiness', 'Readiness', ready);
  const preReady = shared && !shared.taskId ? sharedReadyReviewView(shared) : null;
  if (!ready && shared?.ready) Object.assign(readiness, { state: shared.ready.passed ? 'complete' : 'blocked', detail: shared.ready.passed ? 'The shared readiness check passed.' : shared.ready.issues.join(' ') || 'The shared readiness check has not passed.' });
  if (preReady) Object.assign(readiness, { state: preReady.actor === 'operator' ? 'blocked' : shared?.readyReview?.status === 'passed' ? 'pending' : 'active', detail: preReady.description });
  const execution: FeatureReviewStage = { id: 'execution', label: 'Execution', state: 'unknown', detail: 'No execution result is recorded.' };
  if (pending) Object.assign(execution, { state: 'blocked', detail: pending.kind === 'escalation' ? 'A decision is required before continuation.' : 'An answer is required before continuation.' });
  else if (activeExecution) Object.assign(execution, { state: 'active', detail: status === 'queued' || request?.execution?.status === 'prepared' ? 'An invocation is queued or prepared.' : 'The saved invocation is running.' });
  else if (['failed', 'cancelled', 'interrupted', 'escalated', 'waiting_input', 'needs_rework', 'blocked'].includes(status)) Object.assign(execution, { state: 'blocked', detail: 'The recorded attempt needs attention.' });
  else if (request?.execution?.result?.type === 'completed' || ['completed', 'review', 'done', 'ready_for_review', 'publishing'].includes(status)) Object.assign(execution, { state: 'complete', detail: 'A completed result is recorded. Verification and human review are separate.' });
  else if (status === 'simulated') Object.assign(execution, { state: 'complete', detail: 'Simulation finished. No implemented change is claimed.' });
  else if (['ready', 'draft', 'readiness'].includes(status)) Object.assign(execution, { state: 'pending', detail: 'No execution is confirmed for this request yet.' });
  if (preReady) Object.assign(execution, { state: 'pending', detail: 'Implementation waits for the Ready Check review and Definition of Ready checks.' });
  const verification = gateStage('verification', 'Completion checks', done);
  if (candidate?.implementation) {
    if (!candidate.verified) Object.assign(verification, { state: 'blocked', detail: candidate.description });
    else if (!done) Object.assign(verification, { state: 'unknown', detail: 'Required implementation checks passed; completion gate evidence is unavailable.' });
    else if (acceptanceOnly && !attested) Object.assign(verification, { label: 'Human acceptance', state: 'pending', detail: 'Required checks passed. Your acceptance is not yet recorded.' });
  }
  if (!request && shared?.done) Object.assign(verification, { state: shared.done.passed ? 'complete' : 'blocked', detail: shared.done.passed ? 'The shared completion check passed.' : shared.done.issues.join(' ') || 'The shared completion check has not passed.' });
  const handoff: FeatureReviewStage = { id: 'handoff', label: 'Review handoff', state: 'pending', detail: 'No review handoff is confirmed.' };
  if (sharedSource) {
    if (shared?.publication === 'error') Object.assign(handoff, { state: 'blocked', detail: 'Git publication needs attention. Local evidence remains available.' });
    else if (shared?.publication === 'pending' || shared?.status === 'publishing') Object.assign(handoff, { state: 'active', detail: 'Git publication is pending; team visibility is not yet confirmed.' });
    else if (shared?.status === 'ready_for_review' && shared.publication === 'synced' && shared.featureBranch && shared.reviewNote) Object.assign(handoff, { state: 'complete', detail: 'The feature branch and PullRequest note are published. Human review and merge remain outside this status.' });
    else if (otherOwner) handoff.detail = 'Inspect the owning worker’s shared notes for its handoff.';
  } else if (hasPatch) Object.assign(handoff, { state: 'complete', detail: candidate?.implementation ? 'A patch is retained for inspection. Application to the developer checkout and merge are not tracked here.' : 'A proposed patch is retained. It has not been automatically applied or verified.' });
  else if (request?.phase === 'done') Object.assign(handoff, { state: 'complete', detail: 'Request checks passed. This does not record delivery, human approval or merge.' });
  if (deliveryView) { Object.assign(execution, deliveryView.execution); Object.assign(verification, deliveryView.verification); Object.assign(handoff, deliveryView.handoff); }
  const evidence = { ready, done, deliveryReview: deliveryView?.review ?? null, candidate, openFindings, blockingFindingCount, attestationRequired, attested, hasPatch,
    approvedFileCount: candidate?.approvedPaths.length ?? (request ? request.input.files?.length ?? 0 : null),
    changedFileCount: candidate?.implementation ? candidate.changedPaths.length : task?.changedFileCount ?? null,
    checks: candidate?.implementation ? { passed: candidate.checks.filter(check => check.passed).length, total: candidate.checks.length } : null,
    publication: shared?.publication ?? null };
  const deliveryStep = request?.delivery ? deliveryNextStep(request.delivery) ?? (deliveryView?.review
    ? next('operator', request.lifecycle === 'done' ? 'Inspect the accepted candidate' : 'Review the current delivery candidate', 'Inspect this run’s candidate, required checks and human criteria. Acceptance does not publish or merge changes.', request.lifecycle === 'done' ? 'inspect_history' : 'attest', request.lifecycle === 'done' ? 'Inspect delivery evidence' : 'Review acceptance requirement')
    : next('operator', 'Inspect the current delivery evidence', 'This run has no matching current review package. Earlier patches and completed interactions cannot establish its handoff.', 'inspect_history', 'Inspect delivery evidence')) : null;
  const releaseStep = request?.delivery ? workflowLocalMergeNextStep(request) ?? workflowReleaseNextStep(request) : null;
  let nextStep: FeatureReviewNextStep;
  if (stale) nextStep = next('operator', 'Refresh the request evidence', conflict ? 'These snapshots identify different requests or executions. Refresh before making a decision.' : input.freshness?.error || 'Current request evidence is unavailable or may be stale. Retained results do not authorize an action.', 'refresh', 'Refresh evidence');
  else if (otherOwner) nextStep = next('owning_worker', 'Follow the owning worker', 'This worker can inspect the shared record. Continue through its Task note or the owning worker.', shared?.taskNote || shared?.reviewNote ? 'review_shared' : 'open_source', 'Read shared notes');
  else if (preReady && shared?.publication === 'error') nextStep = next('operator', 'Inspect the review publication failure', shared.error || 'The review is retained locally. Resolve the Git publication failure before answering in the shared Feature Request.', 'open_source', 'Read the Feature Request');
  else if (preReady && shared?.publication === 'pending') nextStep = next('worker', 'Wait for review publication', 'The worker is confirming this review in Git. Wait for its findings to appear in the Feature Request before answering.');
  else if (preReady) nextStep = next(preReady.actor, preReady.label, preReady.description, preReady.actor === 'operator' ? 'open_source' : undefined, 'Read the Feature Request');
  else if (continuationBlocked) nextStep = next('operator', 'Inspect the retained evidence', continuationBlocked + ' Use a new Feature Request if the accepted execution cannot be recovered.', 'inspect_history', 'Inspect execution evidence');
  else if (responsePending) nextStep = next('worker', response?.status === 'publication_pending' ? 'Confirm the saved response publication' : 'Wait for the worker to continue', response?.status === 'publication_pending' ? 'The answer is retained while Git publication is confirmed. Do not submit another answer.' : 'The answer is saved in the shared Task note. Continuation waits for capacity and limits.');
  else if (pending) nextStep = next('operator', pending.kind === 'escalation' ? 'Give the worker a decision' : 'Answer the worker’s question', pending.message, 'answer', 'Answer and continue');
  else if (releaseStep) nextStep = releaseStep;
  else if (deliveryStep) nextStep = deliveryStep;
  else if (activeExecution || activeReview) nextStep = next('worker', activeReview ? 'Wait for the recorded review' : 'Wait for the current invocation', activeReview ? 'A model review or rework is queued or running. Its suggestions are not operator acceptance.' : 'The worker will record its outcome and checks. No completion time is estimated.');
  else if (unclaimed) nextStep = next(shared?.ready?.passed === false ? 'operator' : 'worker', shared?.ready?.passed === false ? 'Resolve readiness findings' : 'Wait for shared intake', shared?.error || shared?.ready?.issues.join(' ') || 'The committed request has not been claimed. Intake will recheck eligibility; local saves alone do not dispatch work.', 'open_source', 'Read the Feature Request');
  else if (remote) nextStep = next('orchestrator', 'Review the owning line’s evidence', 'The orchestrator owns assignment scope and successor execution. Inspect its recorded outcome; simulation does not establish implementation.', 'inspect_history', 'Inspect assignment evidence');
  else if (shared?.publication === 'error') nextStep = next('operator', 'Inspect the publication failure', shared.error || 'The worker retained its result but could not confirm Git publication. Resolve the reported problem; do not create duplicate work.', 'review_shared', 'Inspect shared handoff');
  else if (shared?.publication === 'pending' || shared?.status === 'publishing') nextStep = next('worker', 'Wait for Git publication', 'Implementation evidence and shared publication are separate. The worker is publishing its retained progress or review handoff.');
  else if (['failed', 'cancelled', 'interrupted'].includes(status)) nextStep = sharedSource && status === 'cancelled'
    ? next('operator', 'Create a successor Feature Request', 'This shared request was stopped. Keep its evidence and publish a new request for additional work.', 'open_source', 'Read the source request')
    : interaction?.latestTurn ? next('operator', 'Review the stopped attempt before continuing', task?.error || 'Inspect the saved outcome, then explicitly resume the same accepted scope in a new attempt.', 'resume', 'Inspect continuation controls')
      : next('operator', 'Inspect the stopped attempt', 'No resumable checkpoint is available in this snapshot. Review its evidence before starting more work.', 'inspect_history', 'Inspect execution evidence');
  else if (candidate?.implementation && !candidate.verified) nextStep = next('operator', 'Inspect required verification', candidate.description, 'inspect_checks', 'Inspect checks');
  else if (blockingFindingCount && !acceptanceOnly || done && !done.passed && done.rules.some(rule => rule.result !== 'pass' && rule.fact !== 'operator.accepted')) nextStep = next('operator', 'Resolve the recorded findings', 'Missing or failed evidence blocks completion. Operator acceptance cannot replace required verification.', 'review_request', 'Review checks and findings');
  else if (attestationRequired && !attested && request?.execution?.result?.type === 'completed' && request.execution.outputDigest) nextStep = next('operator', 'Review and record operator acceptance', 'This request policy requires an explicit note for the current input and output. It does not apply a patch or merge changes.', 'attest', 'Review acceptance requirement');
  else if (shared?.status === 'ready_for_review' && handoff.state === 'complete') nextStep = next('operator', 'Review the published feature', 'Inspect the PullRequest note and feature branch. A person reviews and merges through the team’s Git process.', 'review_shared', 'Read the review handoff');
  else if (hasPatch) nextStep = next('operator', 'Review the retained patch', candidate?.description || 'Inspect the proposed changes and recorded checks. No human review, application or merge is inferred.', 'review_patch', 'Inspect patch');
  else nextStep = next('operator', request?.phase === 'done' ? 'Review the recorded result' : 'Review the current request', request?.phase === 'done' ? 'Request checks passed. Inspect the result before relying on it; delivery and merge remain separate.' : 'Inspect readiness, completion checks and open findings to see what the request needs next.', 'review_request', 'Review request evidence');
  return { identity: { featureKey: feature?.key ?? null, featureId: feature?.id ?? request?.owner.featureId ?? null, sessionId: session?.id ?? task?.sessionId ?? request?.owner.sessionId ?? null,
    taskId: task?.id ?? session?.taskId ?? shared?.taskId ?? null, requestId: request?.id ?? task?.requestId ?? session?.requestId ?? null,
    source: feature?.source ?? (sharedSource ? 'shared_git' : remote ? 'orchestrator' : 'interaction'), sourcePath: feature?.sourcePath ?? shared?.name ?? null },
    selection: shared?.selection ?? task?.selection ?? session?.selection ?? null,
    title, summary: nextStep.description, stale, ownership, stages: [readiness, execution, verification, handoff], nextStep, evidence };
}
