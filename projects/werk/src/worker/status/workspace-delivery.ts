import { FeatureIntakeBlocked } from '../application/feature-intake-measurement.js';
import { DomainError } from '../../shared/errors.js';
import { assertDeliveryPolicyApproved } from '../application/delivery-policy-approval.js';
import { inspectDeliveryReadinessReferences } from '../infrastructure/delivery-readiness-references.js';
import { featureDependencyReceipts } from './workspace-feature-dependencies.js';
import { deliveryGatePolicy } from '../application/delivery-policy.js';
import { gateDigest, type GatePolicy } from '../application/request-gates.js';
import type { FeatureInput, FeatureRecord } from '../application/feature-requests.js';
import type { FeatureSourceIssue } from '../application/feature-markdown.js';
import { readDeliveryPolicy } from '../infrastructure/delivery-policy.js';
import type { WorkspaceContext } from './workspace-context.js';

const signalFor = (workspace: WorkspaceContext) => AbortSignal.any([workspace.repositoryStop.signal, AbortSignal.timeout(30000)]);
export async function featureDeliverySubmission(workspace: WorkspaceContext, record: Pick<FeatureRecord, 'id' | 'input' | 'deliveryPolicy' | 'deliveryExecution'>, repository: string, policy: GatePolicy) {
  const input = record.input!, signal = signalFor(workspace);
  const project = workspace.featureProjects.forRepository(repository) ?? workspace.featureProjects.primary;
  const repositoryId = workspace.featureProjects.id(project);
  const snapshot = record.deliveryPolicy ?? await readDeliveryPolicy(repository, signal, input.qualityProfile ?? (input.requestSchema === undefined && input.criteria === undefined ? 'lightweight' : undefined));
  try { assertDeliveryPolicyApproved(workspace.deliveryApprovals.view(), repositoryId, snapshot); }
  catch (error) { throw new FeatureIntakeBlocked(error, 'policy_approval', 'permissions'); }
  const dependencies = await featureDependencyReceipts(workspace, project, record.id, snapshot.baseline, input.dependsOn ?? []);
  const readinessReferences = snapshot.profile.readiness ? await inspectDeliveryReadinessReferences(repository, snapshot.baseline, snapshot.profile.readiness.requiredReferences, signal) : undefined;
  return { repositoryId, ...(readinessReferences ? { readinessReferences } : {}), ...(record.deliveryExecution ? { deliveryExecution: record.deliveryExecution } : {}), deliveryPolicy: snapshot, dependencies, verificationInputs: snapshot.profile.verificationInputs,
    policy: deliveryGatePolicy(policy, snapshot), baseCommit: snapshot.baseline, criteria: input.criteria };
}
export async function featureSourceHold(workspace: WorkspaceContext, record: FeatureRecord, issue: FeatureSourceIssue | null): Promise<void> {
  const request = workspace.sessions.requests.forSession(record.sessionId);
  if (!request || request.phase === 'cancelled' || request.lifecycle === 'done' || request.phase === 'done' && request.lifecycle === undefined) return;
  workspace.sessions.requests.deliveryUpdate(request.id, issue ? { action: 'hold', code: 'source', reason: issue.reason } : { action: 'clear_hold', code: 'source' });
}
/** Source edits replace requirements, never the attempt's approved paths, provider or policy authority. */
export async function reviseFeatureSource(workspace: WorkspaceContext, record: FeatureRecord, input: FeatureInput): Promise<boolean> {
  const request = workspace.sessions.requests.forSession(record.sessionId);
  if (request && ['done', 'cancelled'].includes(request.phase)) return false;
  if (request?.execution && ['running', 'prepared'].includes(request.execution.status) || request?.delivery?.steps.some(step => ['running', 'outcome_unknown'].includes(step.status))) return false;
  const authority = (value: FeatureInput) => ({ mode: value.mode, paths: value.paths, provider: value.provider, model: value.model, effort: value.effort, definitionId: value.definitionId, definitionRef: value.definitionRef, agent: value.agent, useInstructionsOnly: value.useInstructionsOnly, qualityProfile: value.qualityProfile, executionProfile: value.executionProfile });
  if (record.input && gateDigest(authority(record.input)) !== gateDigest(authority(input))) {
    if (!request) throw new DomainError('conflict', 'The request changes its frozen execution authority. Restore the accepted provider, profile and paths, or create a new Feature Request.');
    workspace.sessions.requests.deliveryUpdate(request.id, { action: 'hold', code: 'source', reason: 'The revised request changes its approved paths, provider or quality profile. Restore the accepted execution settings or submit a new request with explicit authority; retained work remains available.' });
    return false;
  }
  if (!request) return !record.submitted && !workspace.board.view().tasks.some(task => task.id === record.taskId) && !workspace.board.preparation(record.taskId) && !workspace.sessions.view().records.some(session => session.id === record.sessionId);
  const task = input.mode === 'patch' ? workspace.board.executionDetail(record.taskId) : undefined;
  const baseline = task?.baseCommit;
  let dependencies = task?.dependencies;
  if (baseline) {
    dependencies = await featureDependencyReceipts(workspace, workspace.featureProjects.forRecord(record), record.id, baseline, input.dependsOn ?? []);
  }
  workspace.sessions.requests.reviseInput(request.id, { ...request.input, title: input.title, message: input.message,
    criteria: [...(input.criteria ?? [])],
    ...(dependencies ? { context: { ...(request.input.context as Record<string, unknown>), dependencies } } : {}) });
  workspace.sessions.requests.deliveryUpdate(request.id, { action: 'clear_hold', code: 'source' });
  const ready = workspace.sessions.requests.evaluate(request.id, 'ready');
  if (ready.passed) {
    if (input.mode === 'patch') await workspace.board.executeRequest(request.id);
    else await workspace.sessions.executeRequest(request.id);
  }
  return true;
}

/** Shared release work remains source-bound after local candidate acceptance. */
export async function sharedFeatureSourceHold(workspace: WorkspaceContext, record: import('../application/shared-feature-state.js').SharedFeatureRecord, reason: string | null) {
  if (!record.taskId) return;
  const task = workspace.board.executionDetail(record.taskId), request = task.requestId ? workspace.sessions.requests.get(task.requestId) : undefined;
  if (!request || request.lifecycle === 'done' || request.phase === 'cancelled') return;
  workspace.sessions.requests.deliveryUpdate(request.id, reason ? { action: 'hold', code: 'source', reason } : { action: 'clear_hold', code: 'source' });
}
