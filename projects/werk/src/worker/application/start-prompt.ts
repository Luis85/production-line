import { gateDigest } from './request-gates.js';
import type { ModelRequest } from './model-contract.js';

export interface StartPromptInput {
  requestId: string; inputRevision: number; inputHash: string; runId: string;
  baseline: string; policyDigest: string; dispatch: ModelRequest; directory?: string;
}
export interface StartPromptReceipt { path: string; digest: string; }
/** The ledger retains the approved dispatch, not the provider connection or its private credentials. */
export function startPromptDocument(input: StartPromptInput) {
  const { dispatch } = input;
  const document = { schemaVersion: 1, requestId: input.requestId, inputRevision: input.inputRevision,
    inputHash: input.inputHash, runId: input.runId, baseline: input.baseline, policyDigest: input.policyDigest,
    provider: { id: dispatch.provider.id, model: dispatch.provider.model, ...(dispatch.provider.authenticationMode ? { authenticationMode: dispatch.provider.authenticationMode } : {}) },
    authority: dispatch.policy, prompt: dispatch.renderedPrompt };
  return { ...document, digest: gateDigest(document) };
}
