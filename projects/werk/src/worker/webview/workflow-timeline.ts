import type { WorkerRequest } from '../application/request-gates';
import { acceptedDeliveryPolicy } from './delivery-policy-view';
import { deliveryReviewStages } from './delivery-review-stages';
export interface WorkflowStage { id: string; label: string; state: 'pending' | 'active' | 'complete' | 'blocked' | 'unknown'; detail: string; }
export const workflowStateLabels = { pending: 'Not yet', active: 'In progress', complete: 'Complete', blocked: 'Needs attention', unknown: 'Not confirmed' };
export function currentWorkflowAcceptance(request: WorkerRequest): boolean {
  return !!deliveryReviewStages(request).review && !!request.attestation && request.attestation.inputHash === request.inputHash && !!request.execution?.outputDigest && request.attestation.outputDigest === request.execution.outputDigest;
}
/** Readable phases project durable evidence; downstream completion cannot be inferred from model output. */
export function workflowTimeline(request: WorkerRequest): WorkflowStage[] {
  const stages: WorkflowStage[] = [
    { id: 'intake', label: 'Worker intake', state: 'complete', detail: 'The Feature Request has a retained identity and accepted input revision.' },
    { id: 'prepare', label: 'Pre-production', state: 'pending', detail: 'Workspace and start prompt preparation are not yet confirmed.' },
    { id: 'produce', label: 'Production', state: 'pending', detail: 'Implementation has not completed for this request revision.' },
    { id: 'verify', label: 'Post-production', state: 'pending', detail: 'Independent verification and a current review package are required.' },
    { id: 'review', label: 'Review', state: 'pending', detail: 'Human review applies to the exact verified candidate.' },
    { id: 'merge', label: 'Merge', state: 'pending', detail: 'No matching merge is confirmed.' },
    { id: 'build', label: 'Build', state: 'pending', detail: 'The merged commit has no confirmed release build.' },
    { id: 'publish', label: 'Publish', state: 'pending', detail: 'The build has no confirmed published release.' },
  ];
  const run = request.delivery;
  const configuration = acceptedDeliveryPolicy(request.input.context)?.configuration;
  const releaseVisible = !!configuration?.release || !!run?.release;
  const localVisible = configuration?.localMerge === true || !!run?.localMerge;
  if (!releaseVisible && localVisible) stages[5].detail = 'The reviewed candidate awaits explicit approval to merge into the assigned project’s main checkout.';
  const visible = () => releaseVisible ? stages : stages.slice(0, localVisible ? 6 : 5);
  if (!run) return visible();
  const current = run.inputRevision === request.inputRevision && run.inputHash === request.inputHash && run.policyDigest === request.policyDigest;
  if (!current) return visible().map(stage => ({ ...stage, state: 'unknown', detail: 'The retained delivery run belongs to earlier input or policy evidence.' }));
  const ready = request.evaluations.findLast(item => item.stage === 'ready' && item.inputRevision === request.inputRevision && item.inputHash === request.inputHash && item.policyDigest === request.policyDigest);
  if (ready && !ready.passed) Object.assign(stages[0], { state: 'blocked', detail: 'Readiness findings must be resolved before implementation.' });
  const phaseStage = { assessing: 0, planning: 1, preparing: 1, implementing: 2, repairing: 2, verifying: 3, packaging: 3 };
  for (const step of run.steps) {
    const stage = stages[phaseStage[step.phase]];
    Object.assign(stage, { state: step.status === 'completed' ? 'complete' : step.status === 'running' ? 'active' : step.status === 'outcome_unknown' ? 'unknown' : 'blocked', detail: step.detail || (step.status === 'completed' ? 'The worker recorded this step as completed.' : 'Inspect the retained step evidence and next action.') });
  }
  const view = deliveryReviewStages(request);
  Object.assign(stages[3], view.verification);
  if (view.review) Object.assign(stages[4], { state: currentWorkflowAcceptance(request) ? 'complete' : 'active', detail: currentWorkflowAcceptance(request) ? 'Human acceptance is recorded for this exact input and output.' : 'Inspect the current candidate, checks and required human criteria.' });
  const release = run.release, candidate = view.review?.candidate;
  if (candidate && release?.merge?.headCommit === candidate.candidateCommit) {
    Object.assign(stages[5], { state: 'complete', detail: 'GitHub confirmed merge commit ' + release.merge.mergeCommit + '.' });
    if (release.build?.commit === release.merge.mergeCommit) {
      Object.assign(stages[6], { state: 'complete', detail: 'The exact merged commit produced ' + release.build.artifacts.length + ' retained, checksummed assets.' });
      if (release.published?.commit === release.build.commit && release.published.assets.length) Object.assign(stages[7], { state: 'complete', detail: 'GitHub Release ' + release.published.tag + ' and its build assets are confirmed.' });
    }
  }
  if (!releaseVisible && localVisible) {
    const merged = run.localMerge?.merged;
    if (merged && merged.candidateCommit === candidate?.candidateCommit) Object.assign(stages[5], { state: 'complete', detail: 'Main checkout merge confirmed on ' + merged.branch + ' at ' + merged.mergeCommit + '.' });
    else for (const operation of run.localMerge?.operations ?? []) {
      if (operation.candidate.candidateCommit === candidate?.candidateCommit && operation.status !== 'confirmed') Object.assign(stages[5], { state: operation.status === 'pending' ? 'active' : operation.status === 'unknown' ? 'unknown' : 'blocked', detail: operation.detail });
    }
  }
  for (const operation of release?.operations ?? []) {
    const stage = stages[operation.action === 'merge' ? 5 : operation.action === 'build' ? 6 : 7];
    if (stage.state === 'complete' || operation.candidate.candidateCommit !== candidate?.candidateCommit || operation.status === 'confirmed') continue;
    Object.assign(stage, { state: operation.status === 'pending' ? 'active' : operation.status === 'unknown' ? 'unknown' : 'blocked', detail: operation.detail });
  }
  return visible();
}
export function workflowReleaseNextStep(request: WorkerRequest) {
  if (!request.delivery || !acceptedDeliveryPolicy(request.input.context)?.configuration.release || !currentWorkflowAcceptance(request)) return null;
  const stages = workflowTimeline(request), stage = stages.slice(5).find(item => item.state !== 'complete');
  return { actor: 'operator' as const, title: stage ? stage.state === 'unknown' ? 'Reconcile the saved ' + stage.label.toLowerCase() + ' outcome' : stage.state === 'blocked' ? 'Inspect the ' + stage.label.toLowerCase() + ' failure' : stage.label === 'Merge' ? 'Merge the reviewed candidate' : stage.label === 'Build' ? 'Build the merged commit' : 'Publish the verified release' : 'Release published',
    description: stage?.detail ?? stages[7].detail, action: { kind: 'review_request' as const, label: stage ? 'Inspect release controls' : 'Inspect release evidence' } };
}

export function workflowLocalMergeNextStep(request: WorkerRequest) {
  const configuration = acceptedDeliveryPolicy(request.input.context)?.configuration;
  if (!request.delivery || configuration?.localMerge !== true || configuration.release || !currentWorkflowAcceptance(request)) return null;
  const stage = workflowTimeline(request).find(item => item.id === 'merge')!;
  return { actor: 'operator' as const, title: stage.state === 'complete' ? 'Main checkout merge confirmed' : stage.state === 'unknown' ? 'Reconcile the saved main checkout merge' : stage.state === 'blocked' ? 'Inspect the main checkout merge failure' : 'Approve merge into main checkout', description: stage.detail, action: { kind: 'review_request' as const, label: stage.state === 'complete' ? 'Inspect main checkout evidence' : 'Inspect main checkout merge controls' } };
}
