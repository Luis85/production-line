import { providerIds, type ProviderId } from './provider-contract.js';
import { DomainError } from '../../shared/errors.js';

export type ProviderAuthenticationMode = 'cli-account' | 'api-key' | 'legacy';
export interface ProviderCapabilities {
  schemaVersion: 1; adapterVersion: '1'; interface: 'cli' | 'http';
  authenticationModes: Array<Exclude<ProviderAuthenticationMode, 'legacy'>>;
  results: 'structured'; streaming: false;
  continuation: 'provider_session' | 'worker_context_replay';
  permissions: 'worker_grants' | 'provider_native';
  workspace: 'worker_tools_only' | 'provider_permissions';
  configuration: 'isolated_with_managed_policy' | 'provider_native';
  interruption: 'await_local_process_tree' | 'abort_http_request';
  remoteCancellation: 'not_confirmed'; usage: 'reported_when_available' | 'unavailable';
  loadedExtensions: 'worker_bridge_only' | 'provider_configuration_not_enumerated';
}
/** Describes the shipped integration, never capabilities inferred from a model's reply. */
export function providerCapabilities(id: ProviderId): ProviderCapabilities {
  const cli = id.endsWith('-cli'), native = id === 'cursor-cli';
  return { schemaVersion: 1, adapterVersion: '1', interface: cli ? 'cli' : 'http',
    authenticationModes: cli ? ['cli-account', 'api-key'] : ['api-key'], results: 'structured', streaming: false,
    continuation: id === 'claude-cli' || native ? 'provider_session' : 'worker_context_replay',
    permissions: native ? 'provider_native' : 'worker_grants', workspace: native ? 'provider_permissions' : 'worker_tools_only',
    configuration: native ? 'provider_native' : 'isolated_with_managed_policy',
    interruption: cli ? 'await_local_process_tree' : 'abort_http_request', remoteCancellation: 'not_confirmed',
    usage: native ? 'unavailable' : 'reported_when_available', loadedExtensions: native ? 'provider_configuration_not_enumerated' : 'worker_bridge_only' };
}
export function validateAuthenticationMode(value: unknown, id: ProviderId): ProviderAuthenticationMode {
  if (!providerIds.includes(id)) throw new DomainError('invalid_input', 'Choose a supported provider.');
  if (value !== 'legacy' && !providerCapabilities(id).authenticationModes.includes(value as 'cli-account' | 'api-key'))
    throw new DomainError('invalid_input', 'Choose a supported authentication and billing mode for this provider.');
  return value as ProviderAuthenticationMode;
}
export function authenticationDescription(mode: ProviderAuthenticationMode | undefined): string {
  return mode === 'cli-account' ? 'Provider account / subscription; API-key fallback disabled'
    : mode === 'api-key' ? 'Private API key; metered API billing; account fallback disabled'
      : 'Choose authentication and billing before running work';
}
