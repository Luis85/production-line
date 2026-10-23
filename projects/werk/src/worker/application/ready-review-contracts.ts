import { validateSnapshot, type DefinitionSnapshot } from './definitions.js';
import { validateModelSelection, type ModelSelection } from './model-selection.js';
import { parseReadyReviewResult } from './ready-review-protocol.js';
import { createHash } from 'node:crypto';
import { DomainError } from '../../shared/errors.js';
import { identifier, object, text } from '../../shared/contracts.js';
import { gateDigest } from './request-gates.js';
import { validateFeatureRequestReference, type FeatureRequestReference } from './feature-request-reference.js';
import { featureWorkflowPath, validateFeatureReadyReview, type FeatureDefinitionPrompt } from './feature-workflow.js';
import { providerIds, type ProviderId } from './provider-contract.js';

/** One committed review revision of the existing FR; this never creates an execution request. */
export interface ReadyReviewInput {
  operationId: string; feature: FeatureRequestReference;
  source: { commit: string; path: string; sha256: string; markdown: string };
  prompt: FeatureDefinitionPrompt; title: string; provider: ProviderId; generation: number;
  previousAssessment?: ReadyReviewResult;
  selection?: ModelSelection;
  definition?: DefinitionSnapshot | null;
  deliveryAuthority?: { repositoryId: string; configurationDigest: string };
  definitionId?: string; definitionRef?: string; agent?: string; useInstructionsOnly?: boolean;
}
export interface ReadyReviewResult {
  passed: boolean; summary: string;
  findings: { kind: 'question' | 'issue' | 'gap'; message: string; blocking: boolean }[];
}
export interface ReadyReviewAttempt { operationId: string; sessionId: string; turnId: string; runId: string | null; }
export interface ReadyReviewExecutionView extends ReadyReviewAttempt {
  state: 'queued' | 'running' | 'completed' | 'interrupted' | 'failed';
  result?: ReadyReviewResult; error?: string;
}
export interface ReadyReviewPort {
  schedule(input: ReadyReviewInput): Promise<ReadyReviewAttempt>;
  inspect(input: ReadyReviewInput): ReadyReviewExecutionView | undefined;
}
export const readyReviewSessionId = (input: Pick<ReadyReviewInput, 'feature' | 'provider'>) => 'ready-review-' + gateDigest([input.feature.key, input.provider]).slice(0, 40);
export function validateReadyReviewInput(value: unknown): ReadyReviewInput {
  const raw = object(value, 'Ready Check input', ['operationId', 'feature', 'source', 'prompt', 'title', 'provider', 'generation', 'previousAssessment', 'selection', 'definition', 'deliveryAuthority', 'definitionId', 'definitionRef', 'agent', 'useInstructionsOnly']);
  const source = object(raw.source, 'Ready Check source', ['commit', 'path', 'sha256', 'markdown']);
  if (typeof source.commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commit)
    || typeof source.markdown !== 'string' || !source.markdown.trim() || source.markdown.includes('\0') || Buffer.byteLength(source.markdown) > 65536
    || Buffer.from(source.markdown).toString('utf8') !== source.markdown
    || source.sha256 !== createHash('sha256').update(source.markdown).digest('hex')
    || !providerIds.includes(raw.provider as ProviderId) || !Number.isSafeInteger(raw.generation) || Number(raw.generation) < 1)
    throw new DomainError('invalid_input', 'Ready Check requires a bounded committed source, matching digest, provider and generation.');
  const prompt = validateFeatureReadyReview({ schemaVersion: 1, commit: source.commit, prompt: raw.prompt }).prompt;
  const result: ReadyReviewInput = {
    operationId: identifier(raw.operationId, 'Ready Check operation'), feature: validateFeatureRequestReference(raw.feature),
    source: { commit: source.commit, path: featureWorkflowPath(source.path), sha256: source.sha256 as string, markdown: source.markdown },
    prompt, title: text(raw.title, 'Ready Check title', 120), provider: raw.provider as ProviderId, generation: Number(raw.generation),
  };
  if (raw.selection !== undefined) {
    result.selection = validateModelSelection(raw.selection);
    if (result.selection.provider !== result.provider) throw new DomainError('conflict', 'Ready Check model selection belongs to a different provider.');
  }
  if (raw.definition !== undefined) {
    if (raw.definition !== null) validateSnapshot(raw.definition);
    result.definition = structuredClone(raw.definition as DefinitionSnapshot | null);
  }
  if (raw.deliveryAuthority !== undefined) {
    const authority = object(raw.deliveryAuthority, 'Ready Check project authority', ['repositoryId', 'configurationDigest']);
    const repositoryId = identifier(authority.repositoryId, 'Repository ID');
    if (repositoryId !== result.feature.repositoryId || typeof authority.configurationDigest !== 'string' || !/^[a-f0-9]{64}$/.test(authority.configurationDigest))
      throw new DomainError('conflict', 'Ready Check authority must identify the accepted project and exact policy digest.');
    result.deliveryAuthority = { repositoryId, configurationDigest: authority.configurationDigest };
  }
  if (raw.previousAssessment !== undefined) result.previousAssessment = parseReadyReviewResult({ ...object(raw.previousAssessment, 'Previous Ready Check assessment', ['passed', 'summary', 'findings']), schemaVersion: 1 });
  for (const field of ['definitionId', 'definitionRef', 'agent'] as const) if (raw[field] !== undefined) result[field] = text(raw[field], field, 512);
  if (raw.useInstructionsOnly !== undefined) {
    if (typeof raw.useInstructionsOnly !== 'boolean') throw new DomainError('invalid_input', 'Ready Check useInstructionsOnly must be boolean.');
    result.useInstructionsOnly = raw.useInstructionsOnly;
  }
  return result;
}
