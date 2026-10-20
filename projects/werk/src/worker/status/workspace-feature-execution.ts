import { FeatureIntakeBlocked } from '../application/feature-intake-measurement.js';
import { DomainError } from '../../shared/errors.js';
import { assertDeliveryPolicyApproved } from '../application/delivery-policy-approval.js';
import { resolveDeliveryExecutionProfile, deliveryExecutionProfileSelection } from '../application/delivery-execution-policy.js';
import { validateDeliveryExecutionSnapshot } from '../application/delivery-execution-snapshot.js';
import type { FeatureInput } from '../application/feature-requests.js';
import type { FeaturePreparation } from '../application/feature-preparation.js';
import { modelSelection, selectedConnection } from '../application/model-selection.js';
import { readDeliveryPolicy } from '../infrastructure/delivery-policy.js';
import type { WorkspaceContext } from './workspace-context.js';

/** Resolve named profiles from approved committed policy, once; mutable defaults cannot alter a reserved request. */
export async function prepareFeatureExecution(workspace: WorkspaceContext, input: FeatureInput, repository: string, repositoryId: string, baseline?: string): Promise<FeaturePreparation> {
  const legacy = () => ({ selection: modelSelection(workspace.settings.provider(input.provider), input, workspace.definitions.select({ ...input })) });
  if (input.mode !== 'patch' || !baseline && input.requestSchema !== 'worker.request/v1' && !input.executionProfile) {
    if (input.executionProfile) throw new DomainError('invalid_input', 'Named project execution profiles require a repository implementation request.');
    return legacy();
  }
  const signal = AbortSignal.any([workspace.repositoryStop.signal, AbortSignal.timeout(30000)]);
  const policy = await readDeliveryPolicy(repository, signal, input.qualityProfile, baseline);
  const execution = policy.configuration.execution;
  if (!execution && input.executionProfile) throw new DomainError('conflict', 'Configure and approve project execution profiles before selecting execution_profile.');
  // Existing shared workflows retain their gate contract unless they opt into project delivery.
  if (!execution && input.requestSchema !== 'worker.request/v1') return legacy();
  try { assertDeliveryPolicyApproved(workspace.deliveryApprovals.view(), repositoryId, policy); }
  catch (error) { throw new FeatureIntakeBlocked(error, 'policy_approval', 'permissions'); }
  if (!execution) return { ...legacy(), deliveryPolicy: policy };
  const resolution = resolveDeliveryExecutionProfile(execution, input.executionProfile, { qualityProfile: policy.profile.id, mode: input.mode, priority: input.priority });
  const profileSnapshots = execution.profiles.map(profile => {
    const definition = workspace.definitions.select({ definitionRef: profile.definitionRef, agent: profile.agent, useInstructionsOnly: profile.useInstructionsOnly });
    const selection = { ...deliveryExecutionProfileSelection(profile), model: profile.model || definition?.model || '' };
    selectedConnection(workspace.settings.provider(profile.provider), selection, definition);
    return { profileId: profile.id, selection, ...(definition ? { definition } : {}) };
  });
  const selected = profileSnapshots.find(snapshot => snapshot.profileId === resolution.profile.id)!;
  const authored = { provider: input.providerExplicit === false ? undefined : input.provider, model: input.model || undefined, effort: input.effort,
    definitionRef: input.definitionRef, agent: input.agent, useInstructionsOnly: input.useInstructionsOnly };
  const expected = { ...resolution.profile, model: selected.selection.model };
  for (const [key, value] of Object.entries(authored)) if (value !== undefined && value !== expected[key as keyof typeof expected])
    throw new DomainError('conflict', `Feature Request ${key} conflicts with execution profile ${resolution.profile.id}. Remove the override or select an authorized matching profile.`);
  if (input.definitionId !== undefined && input.definitionId !== selected.definition?.definitionId)
    throw new DomainError('conflict', 'The requested agent definition differs from its authorized execution profile.');
  const deliveryExecution = validateDeliveryExecutionSnapshot({ policy: execution, resolution, selection: selected.selection, ...(selected.definition ? { definition: selected.definition } : {}), profileSnapshots });
  return { selection: selected.selection, deliveryPolicy: policy, deliveryExecution };
}
