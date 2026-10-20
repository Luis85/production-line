import { DomainError } from '../../shared/errors.js';
import { featureInputHash, type SharedFeatureInput } from './feature-workflow.js';
import { gateDigest } from './request-gates.js';
import { sharedHash } from './shared-feature-notes.js';
import { validateModelSelection } from './model-selection.js';
import type { SharedFeatureRecord } from './shared-feature-state.js';

/** Legacy reservations retain their exact digest; new claims bind the resolved model selection. */
export function sharedFeatureInputHash(record: Pick<SharedFeatureRecord, 'accepted' | 'workflow' | 'sourceCommit' | 'sourceMarkdown' | 'selection' | 'deliveryPolicy' | 'deliveryExecution'>): string {
  return sharedHash(featureInputHash(record.accepted) + record.workflow.policyDigest + record.sourceCommit + sharedHash(record.sourceMarkdown)
    + (record.selection ? gateDigest(record.selection) : '') + (record.deliveryPolicy ? gateDigest(record.deliveryPolicy) : '') + (record.deliveryExecution ? gateDigest(record.deliveryExecution) : ''));
}
export function assertSharedFeatureSelection(record: Pick<SharedFeatureRecord, 'accepted' | 'selection'>): void {
  if (!record.selection) return;
  const selection = validateModelSelection(record.selection), input = record.accepted;
  if (input.providerExplicit !== false && selection.provider !== input.provider || input.model !== undefined && input.model !== '' && input.model !== selection.model || input.effort !== undefined && input.effort !== selection.effort)
    throw new DomainError('conflict', 'The accepted model selection does not match this Feature Request.');
}
/** Replies may clarify work, but cannot replace accepted model, profile or definition authority. */
export function assertSharedFeatureReplySelection(record: SharedFeatureRecord, input: SharedFeatureInput): void {
  if ((record.selection || record.deliveryExecution) && ['provider', 'model', 'effort', 'executionProfile', 'definitionId', 'definitionRef', 'agent', 'useInstructionsOnly'].some(key => input[key as keyof SharedFeatureInput] !== record.accepted[key as keyof SharedFeatureInput]))
    throw new DomainError('conflict', 'Keep the accepted provider, model and effort unchanged when answering, including the execution profile and agent definition. Create a new Feature Request to use a different model selection.');
}
