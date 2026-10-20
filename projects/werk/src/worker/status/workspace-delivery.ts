import { resolve } from 'node:path';
import { deliveryDependencies, type AcceptedDependency } from '../application/delivery-dependencies.js';
import { deliveryGatePolicy } from '../application/delivery-policy.js';
import { gateDigest, type GatePolicy } from '../application/request-gates.js';
import type { FeatureInput, FeatureRecord } from '../application/feature-requests.js';
import type { FeatureSourceIssue } from '../application/feature-markdown.js';
import { readDeliveryPolicy, deliveryCommitInBaseline } from '../infrastructure/delivery-policy.js';
import type { WorkspaceContext } from './workspace-context.js';

const signalFor = (workspace: WorkspaceContext) => AbortSignal.any([workspace.repositoryStop.signal, AbortSignal.timeout(30000)]);
export function effectiveDeliveryPolicy(workspace: WorkspaceContext) {
  return readDeliveryPolicy(resolve(workspace.config.projectDir ?? process.cwd()), signalFor(workspace));
}
export async function featureDeliverySubmission(workspace: WorkspaceContext, record: FeatureRecord, repository: string, policy: GatePolicy) {
  const input = record.input!, signal = signalFor(workspace);
  const snapshot = await readDeliveryPolicy(repository, signal, input.qualityProfile ?? (input.requestSchema === undefined && input.criteria === undefined ? 'lightweight' : undefined));
  const graph = workspace.features!.dependencyInputs();
  if (!graph.some(node => node.id === record.id)) graph.push({ id: record.id, dependsOn: input.dependsOn ?? [] });
  const dependencies = await deliveryDependencies(record.id, graph, snapshot.baseline, {
    accepted: id => acceptedDependency(workspace, id),
    incorporated: (commit, baseline) => deliveryCommitInBaseline(repository, commit, baseline, signal),
  });
  return { deliveryPolicy: snapshot, dependencies, verificationInputs: snapshot.profile.verificationInputs,
    policy: deliveryGatePolicy(policy, snapshot), baseCommit: snapshot.baseline, criteria: input.criteria };
}
function acceptedDependency(workspace: WorkspaceContext, id: string): AcceptedDependency | undefined {
  const record = workspace.features?.view().records.find(item => item.id === id);
  if (!record) return;
  const request = workspace.sessions.requests.forSession(record.sessionId);
  if (!request || request.phase !== 'done' || request.attestation?.inputHash !== request.inputHash || request.attestation.outputDigest !== request.execution?.outputDigest) return;
  return { id, requestId: request.id, inputRevision: request.inputRevision, includesCode: request.input.kind === 'patch',
    ...(request.delivery?.review ? { candidateCommit: request.delivery?.review.candidate.candidateCommit } : {}) };
}
export async function featureSourceHold(workspace: WorkspaceContext, record: FeatureRecord, issue: FeatureSourceIssue | null): Promise<void> {
  const request = workspace.sessions.requests.forSession(record.sessionId);
  if (!request || ['done', 'cancelled'].includes(request.phase)) return;
  workspace.sessions.requests.deliveryUpdate(request.id, issue ? { action: 'hold', code: 'source', reason: issue.reason } : { action: 'clear_hold', code: 'source' });
}
/** Source edits replace requirements, never the attempt's approved paths, provider or policy authority. */
export async function reviseFeatureSource(workspace: WorkspaceContext, record: FeatureRecord, input: FeatureInput): Promise<boolean> {
  const request = workspace.sessions.requests.forSession(record.sessionId);
  if (!request) return !record.submitted && !workspace.board.view().tasks.some(task => task.id === record.taskId) && !workspace.board.preparation(record.taskId) && !workspace.sessions.view().records.some(session => session.id === record.sessionId);
  if (['done', 'cancelled'].includes(request.phase)) return false;
  if (request.execution && ['running', 'prepared'].includes(request.execution.status) || request.delivery?.steps.some(step => ['running', 'outcome_unknown'].includes(step.status))) return false;
  const authority = (value: FeatureInput) => ({ mode: value.mode, paths: value.paths, provider: value.provider, model: value.model, effort: value.effort, definitionId: value.definitionId, definitionRef: value.definitionRef, agent: value.agent, useInstructionsOnly: value.useInstructionsOnly, qualityProfile: value.qualityProfile });
  if (record.input && gateDigest(authority(record.input)) !== gateDigest(authority(input))) {
    workspace.sessions.requests.deliveryUpdate(request.id, { action: 'hold', code: 'source', reason: 'The revised request changes its approved paths, provider or quality profile. Restore the accepted execution settings or submit a new request with explicit authority; retained work remains available.' });
    return false;
  }
  const task = input.mode === 'patch' ? workspace.board.executionDetail(record.taskId) : undefined;
  const baseline = task?.baseCommit;
  let dependencies = task?.dependencies;
  if (baseline) {
    const graph = workspace.features!.dependencyInputs().filter(node => node.id !== record.id);
    graph.push({ id: record.id, dependsOn: input.dependsOn ?? [] });
    dependencies = await deliveryDependencies(record.id, graph, baseline, {
      accepted: id => acceptedDependency(workspace, id),
      incorporated: (commit, base) => deliveryCommitInBaseline(task!.repository, commit, base, signalFor(workspace)),
    });
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
