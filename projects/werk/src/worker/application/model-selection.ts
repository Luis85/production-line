import { validateAuthenticationMode, type ProviderAuthenticationMode } from './provider-capabilities.js';
import { DomainError } from '../../shared/errors.js';
import { object } from '../../shared/contracts.js';
import { definitionConnection, type DefinitionSnapshot } from './definitions.js';
import { providerIds, type ProviderConnection, type ProviderId } from './provider-contract.js';
import { validateModelEffort, validateModelName, type ModelEffort } from './model-effort.js';
export type { ModelEffort } from './model-effort.js';

/** Accepted configuration, never credentials; default effort is explicit so later settings cannot replace it. */
export interface ModelSelection { provider: ProviderId; model: string; effort: ModelEffort; authenticationMode?: ProviderAuthenticationMode; }
export function validateModelSelection(value: unknown): ModelSelection {
  const raw = object(value, 'Accepted model selection', ['provider', 'model', 'effort', 'authenticationMode']);
  if (!providerIds.includes(raw.provider as ProviderId) || raw.effort === undefined)
    throw new DomainError('invalid_input', 'Accepted model selection requires its provider, model and effort.');
  return { provider: raw.provider as ProviderId, model: validateModelName(raw.model), effort: validateModelEffort(raw.effort, raw.provider as string), ...(raw.authenticationMode === undefined ? {} : { authenticationMode: validateAuthenticationMode(raw.authenticationMode, raw.provider as ProviderId) }) };
}
export function modelSelection(connection: ProviderConnection, input: { model?: unknown; effort?: unknown } = {}, definition?: DefinitionSnapshot): ModelSelection {
  const profile = definitionConnection(connection, definition);
  const selection = validateModelSelection({ provider: connection.id, authenticationMode: connection.authenticationMode,
    model: input.model === undefined || input.model === '' ? profile.model : input.model,
    effort: input.effort === undefined || input.effort === '' ? connection.effort ?? 'default' : input.effort });
  if (selection.provider.endsWith('-api') && !selection.model)
    throw new DomainError('invalid_input', 'Choose a model for this API connection before accepting the feature request.');
  return selection;
}
export class ProviderAuthenticationChanged extends DomainError {
  constructor() { super('conflict', 'Provider authentication and billing changed. Restore the accepted mode to continue this request, or create a new Feature Request for the selected mode.'); }
}
/** Reuse current credentials with the accepted model and frozen profile instructions. */
export function selectedConnection(connection: ProviderConnection, selection: ModelSelection, definition?: DefinitionSnapshot): ProviderConnection {
  const accepted = validateModelSelection(selection);
  const apiMode = accepted.provider.endsWith('-api') ? 'api-key' : undefined;
  if ((accepted.authenticationMode ?? apiMode) !== (connection.authenticationMode ?? apiMode)) throw new ProviderAuthenticationChanged();
  if (accepted.provider !== connection.id) throw new DomainError('conflict', 'Accepted model selection belongs to a different provider.');
  return { ...definitionConnection(connection, definition), model: accepted.model, effort: accepted.effort };
}
