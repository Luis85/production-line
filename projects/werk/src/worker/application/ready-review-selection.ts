import { definitionConnection, type WorkerDefinitions } from './definitions.js';
import { selectedConnection } from './model-selection.js';
import type { ProviderConnection } from './provider-contract.js';
import type { ReadyReviewInput } from './ready-review-contracts.js';
import type { ModelProvider } from './model-contract.js';

/** A named project profile freezes both a definition and its intentional absence at admission. */
export function readyReviewProfile(input: ReadyReviewInput, current: ProviderConnection, selectDefinition: WorkerDefinitions['select']): ModelProvider {
  const definition = input.definition !== undefined ? input.definition ?? undefined : selectDefinition({ definitionId: input.definitionId, definitionRef: input.definitionRef, agent: input.agent, useInstructionsOnly: input.useInstructionsOnly });
  const connection = input.selection ? selectedConnection(current, input.selection, definition) : definitionConnection(current, definition);
  return { id: connection.id, model: connection.model, instruction: connection.instruction ?? '', ...(connection.authenticationMode ? { authenticationMode: connection.authenticationMode } : {}), ...(connection.effort === undefined ? {} : { effort: connection.effort }) };
}
