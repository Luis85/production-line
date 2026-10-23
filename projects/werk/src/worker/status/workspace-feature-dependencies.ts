import { FeatureIntakeBlocked } from '../application/feature-intake-measurement.js';
import type { FeatureRequests } from '../application/feature-requests.js';
import type { SharedFeatureIntake } from '../application/shared-feature-intake.js';
import { DomainError } from '../../shared/errors.js';
import type { AcceptedDependency, DeliveryDependencyNode } from '../application/delivery-dependencies.js';
import { planDeliveryDependencies, type DeliveryDependencyPlan } from '../application/delivery-dependency-plan.js';
import { readDeliveryPolicy, deliveryCommitInBaseline } from '../infrastructure/delivery-policy.js';
import type { WorkspaceContext } from './workspace-context.js';
import type { WorkspaceFeatureProject } from './workspace-project-features.js';

const plans = new WeakMap<WorkspaceContext, Map<string, DeliveryDependencyPlan>>();
const qualified = (projectId: string, id: string) => id.includes(':') ? id : projectId + ':' + id;
const signalFor = (workspace: WorkspaceContext) => AbortSignal.any([workspace.repositoryStop.signal, AbortSignal.timeout(30000)]);
function catalog(workspace: WorkspaceContext) {
  const nodes: DeliveryDependencyNode[] = [], sessions = new Map<string, { sessionId: string; project: WorkspaceFeatureProject }>();
  for (const project of workspace.featureProjects.all()) {
    const features: FeatureRequests | undefined = project.features;
    const intake: SharedFeatureIntake = project.sharedRuntime.intake;
    const projectId = workspace.featureProjects.id(project), binding = intake.binding;
    if (!binding?.repositoryId) {
      const records = features?.view().records ?? [];
      for (const node of features?.dependencyInputs() ?? []) nodes.push({ id: qualified(projectId, node.id), dependsOn: node.dependsOn.map(id => qualified(projectId, id)) });
      for (const record of records) sessions.set(qualified(projectId, record.id), { sessionId: record.sessionId, project });
    }
    for (const node of intake.dependencyInputs()) {
      nodes.push({ id: qualified(node.repositoryId, node.id), dependsOn: node.dependsOn.map(id => qualified(node.repositoryId, id)) });
      if (node.sessionId) sessions.set(qualified(node.repositoryId, node.id), { sessionId: node.sessionId, project });
    }
  }
  return { nodes, sessions };
}
/** Cross-project code dependencies are proven in their own selected integration baseline, never in an unrelated repository. */
export async function featureDependencyPlan(workspace: WorkspaceContext, project: WorkspaceFeatureProject, id: string, baseline?: string, dependsOn?: string[]) {
  const projectId = workspace.featureProjects.id(project), repository = workspace.featureProjects.repository(project), target = qualified(projectId, id), signal = signalFor(workspace);
  const selected = baseline ?? (await readDeliveryPolicy(repository, signal, undefined, project.sharedRuntime.intake.binding?.repositoryId ? await project.sharedRuntime.selectedBaseline(signal) : undefined)).baseline;
  const { nodes, sessions } = catalog(workspace);
  if (dependsOn) { const at = nodes.findIndex(node => node.id === target); const node = { id: target, dependsOn: dependsOn.map(value => qualified(projectId, value)) }; if (at < 0) nodes.push(node); else nodes[at] = node; }
  const structural = await planDeliveryDependencies(target, nodes, selected, { accepted: () => undefined, incorporated: async () => false });
  if (structural.blockers.some(item => ['unknown', 'duplicate', 'cycle', 'limit'].includes(item.code))) return remember(workspace, structural);
  const reachable = new Set(structural.nodes.map(node => node.id));
  const accepted = new Map<string, AcceptedDependency>(), baselines = new Map<string, string>(), repositories = new Map<string, string>();
  for (const [nodeId, owner] of sessions) {
    if (!reachable.has(nodeId) || nodeId === target) continue;
    const request = workspace.sessions.requests.forSession(owner.sessionId);
    if (!request || request.phase !== 'done' || request.attestation?.inputHash !== request.inputHash || request.attestation.outputDigest !== request.execution?.outputDigest) continue;
    const repositoryId = nodeId.slice(0, nodeId.indexOf(':'));
    const assignment = workspace.settings.value.repositories.items.find(item => item.id === repositoryId);
    const predecessorRepository = assignment?.path ?? owner.project.repository;
    repositories.set(repositoryId, predecessorRepository);
    let integrationBaseline: string | undefined;
    if (repositoryId !== projectId && request.input.kind === 'patch') {
      integrationBaseline = baselines.get(repositoryId);
      if (!integrationBaseline) {
        const binding = owner.project.sharedRuntime.intake.binding;
        try { const reference = binding?.repositoryId === repositoryId ? await owner.project.sharedRuntime.selectedBaseline(signal) : assignment?.branch ? `refs/remotes/${assignment.remote}/${assignment.branch}` : undefined;
          integrationBaseline = (await readDeliveryPolicy(predecessorRepository, signal, undefined, reference)).baseline; baselines.set(repositoryId, integrationBaseline); }
        catch { integrationBaseline = 'unavailable'; }
      }
    }
    accepted.set(nodeId, { id: nodeId, repositoryId, requestId: request.id, inputRevision: request.inputRevision, includesCode: request.input.kind === 'patch',
      ...(request.delivery?.review ? { candidateCommit: request.delivery.review.candidate.candidateCommit } : {}), ...(integrationBaseline ? { integrationBaseline } : {}) });
  }
  const plan = await planDeliveryDependencies(target, nodes, selected, {
    accepted: nodeId => accepted.get(nodeId),
    incorporated: (commit, pinned, predecessor) => {
      if (pinned === 'unavailable') throw new DomainError('unavailable', 'The predecessor project baseline is unavailable.');
      return deliveryCommitInBaseline(predecessor?.repositoryId ? repositories.get(predecessor.repositoryId) ?? repository : repository, commit, pinned, signal);
    },
  });
  return remember(workspace, plan);
}
function remember(workspace: WorkspaceContext, plan: DeliveryDependencyPlan) { const cache = plans.get(workspace) ?? new Map(); cache.set(plan.target, structuredClone(plan)); plans.set(workspace, cache); return plan; }
export function retainedFeatureDependencyPlans(workspace: WorkspaceContext, projectId: string) { return structuredClone([...(plans.get(workspace)?.values() ?? [])].filter(plan => plan.target.startsWith(projectId + ':'))); }
export async function featureDependencyReceipts(workspace: WorkspaceContext, project: WorkspaceFeatureProject, id: string, baseline: string, dependsOn: string[]) {
  const plan = await featureDependencyPlan(workspace, project, id, baseline, dependsOn);
  if (!plan.ready) throw new FeatureIntakeBlocked(new DomainError('conflict', plan.blockers[0]!.reason), 'dependency', 'dependency');
  return plan.nodes.flatMap(node => node.receipt ? [node.receipt] : []);
}
