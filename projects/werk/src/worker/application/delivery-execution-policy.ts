import { resolveValidatedDeliveryExecutionProfile } from './delivery-execution-routing.js';
import { DomainError } from '../../shared/errors.js';
import { object } from '../../shared/contracts.js';
import { providerCapabilities, validateAuthenticationMode } from './provider-capabilities.js';
import { providerIds, type ProviderId } from './provider-contract.js';
import { validateModelSelection, type ModelSelection } from './model-selection.js';
import { validateModelEffort, validateModelName, type ModelEffort } from './model-effort.js';

/** Trusted named choices refer to private worker connections; credentials never enter project policy. */
export interface DeliveryExecutionProfile {
  id: string; provider: ProviderId; model: string; effort: ModelEffort;
  authenticationMode: 'cli-account' | 'api-key';
  boundary: 'worker_grants' | 'provider_native';
  definitionRef?: string; agent?: string; useInstructionsOnly?: boolean;
}
export interface DeliveryExecutionRoutingRule {
  id: string; profile: string; qualityProfiles?: string[];
  modes?: ('chat' | 'patch')[]; priorities?: (0 | 1 | 2 | 3)[];
}
export interface DeliveryExecutionPolicy {
  profiles: DeliveryExecutionProfile[]; defaultProfile: string;
  allowedOverrides: string[]; reviewProfile?: string;
  fallbackProfiles: string[]; fallbackOn: ('quota_exhausted' | 'rate_limited' | 'unavailable')[];
  maxHandoffs: number; routing?: DeliveryExecutionRoutingRule[];
}
export interface DeliveryExecutionRoutingInput { qualityProfile?: string; mode?: 'chat' | 'patch'; priority?: number; }
export interface DeliveryExecutionResolution {
  profile: DeliveryExecutionProfile; source: 'override' | 'rule' | 'default'; ruleId?: string;
}
function invalid(message: string): never { throw new DomainError('invalid_input', message); }
function name(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) invalid(`${label} must be a lowercase name of at most 64 characters.`);
  return value as string;
}
function names(value: unknown, label: string, maximum = 16): string[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(`${label} requires at most ${maximum} names.`);
  const result = (value as unknown[]).map(item => name(item, label));
  if (new Set(result).size !== result.length) invalid(`${label} must not contain duplicate names.`);
  return result;
}
function profile(value: unknown): DeliveryExecutionProfile {
  const raw = object(value, 'Delivery execution profile', ['id', 'provider', 'model', 'effort', 'authenticationMode', 'boundary', 'definitionRef', 'agent', 'useInstructionsOnly']);
  if (!providerIds.includes(raw.provider as ProviderId)) invalid('Choose a supported execution-profile provider.');
  const provider = raw.provider as ProviderId;
  const authenticationMode = validateAuthenticationMode(raw.authenticationMode, provider);
  if (authenticationMode === 'legacy') invalid('Execution profiles require an explicit authentication and billing mode.');
  const model = validateModelName(raw.model), effort = validateModelEffort(raw.effort, provider);
  if (provider.endsWith('-api') && !model) invalid('An API execution profile requires a model.');
  if (raw.boundary !== providerCapabilities(provider).permissions) invalid('The execution profile boundary must match the selected adapter. Cursor requires explicit provider_native permissions.');
  const result: DeliveryExecutionProfile = {
    id: name(raw.id, 'Execution profile ID'), provider, model, effort,
    authenticationMode: authenticationMode as 'cli-account' | 'api-key',
    boundary: raw.boundary as DeliveryExecutionProfile['boundary'],
  };
  if (raw.definitionRef !== undefined) {
    if (typeof raw.definitionRef !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(raw.definitionRef)) invalid('Execution-profile definitionRef must identify an imported definition.');
    result.definitionRef = raw.definitionRef as string;
  }
  if (raw.agent !== undefined) {
    if (!result.definitionRef || typeof raw.agent !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(raw.agent)) invalid('Select a named agent only with an execution-profile definitionRef.');
    result.agent = raw.agent as string;
  }
  if (raw.useInstructionsOnly !== undefined) {
    if (!result.definitionRef || typeof raw.useInstructionsOnly !== 'boolean') invalid('Instructions-only adaptation requires a definition and a boolean choice.');
    result.useInstructionsOnly = raw.useInstructionsOnly as boolean;
  }
  return result;
}
function routing(value: unknown, configured: Set<string>): DeliveryExecutionRoutingRule[] {
  if (!Array.isArray(value) || value.length > 32) invalid('Execution routing supports at most 32 ordered rules.');
  const rules = (value as unknown[]).map(item => {
    const raw = object(item, 'Execution routing rule', ['id', 'profile', 'qualityProfiles', 'modes', 'priorities']);
    const result: DeliveryExecutionRoutingRule = { id: name(raw.id, 'Routing rule ID'), profile: name(raw.profile, 'Routing profile') };
    if (!configured.has(result.profile)) invalid('Routing rules must select a configured execution profile.');
    if (raw.qualityProfiles !== undefined) {
      result.qualityProfiles = names(raw.qualityProfiles, 'Routing quality profiles');
      if (!result.qualityProfiles.length) invalid('A routing quality-profile condition cannot be empty.');
    }
    if (raw.modes !== undefined) {
      if (!Array.isArray(raw.modes) || !raw.modes.length || raw.modes.length > 2 || new Set(raw.modes).size !== raw.modes.length || raw.modes.some(mode => typeof mode !== 'string' || !['chat', 'patch'].includes(mode))) invalid('Routing modes must select chat, patch, or both without duplicates.');
      result.modes = [...raw.modes] as DeliveryExecutionRoutingRule['modes'];
    }
    if (raw.priorities !== undefined) {
      if (!Array.isArray(raw.priorities) || !raw.priorities.length || raw.priorities.length > 4 || new Set(raw.priorities).size !== raw.priorities.length || raw.priorities.some(priority => ![0, 1, 2, 3].includes(priority as number))) invalid('Routing priorities must select distinct values from 0 through 3.');
      result.priorities = [...raw.priorities] as DeliveryExecutionRoutingRule['priorities'];
    }
    if (!result.qualityProfiles && !result.modes && !result.priorities) invalid('A routing rule requires at least one explicit condition; use defaultProfile for the default.');
    return result;
  });
  if (new Set(rules.map(rule => rule.id)).size !== rules.length) invalid('Execution routing rule IDs must be unique.');
  return rules;
}
export function validateDeliveryExecutionPolicy(value: unknown): DeliveryExecutionPolicy {
  const raw = object(value, 'Delivery execution policy', ['profiles', 'defaultProfile', 'allowedOverrides', 'reviewProfile', 'fallbackProfiles', 'fallbackOn', 'maxHandoffs', 'routing']);
  if (!Array.isArray(raw.profiles) || !raw.profiles.length || raw.profiles.length > 16) invalid('Delivery execution requires 1–16 named profiles.');
  const profiles = (raw.profiles as unknown[]).map(profile), configured = new Set(profiles.map(item => item.id));
  if (configured.size !== profiles.length) invalid('Execution profile IDs must be unique.');
  const result: DeliveryExecutionPolicy = {
    profiles, defaultProfile: name(raw.defaultProfile, 'Default execution profile'),
    allowedOverrides: names(raw.allowedOverrides, 'Allowed request overrides'),
    fallbackProfiles: names(raw.fallbackProfiles, 'Fallback profiles'),
    fallbackOn: [], maxHandoffs: Number(raw.maxHandoffs),
  };
  if (raw.reviewProfile !== undefined) result.reviewProfile = name(raw.reviewProfile, 'Review profile');
  for (const id of [result.defaultProfile, ...result.allowedOverrides, ...result.fallbackProfiles, ...(result.reviewProfile ? [result.reviewProfile] : [])])
    if (!configured.has(id)) invalid(`Execution profile ${id} is not configured.`);
  const triggers = ['quota_exhausted', 'rate_limited', 'unavailable'] as const;
  if (!Array.isArray(raw.fallbackOn) || raw.fallbackOn.length > triggers.length || new Set(raw.fallbackOn).size !== raw.fallbackOn.length || raw.fallbackOn.some(trigger => !triggers.includes(trigger as typeof triggers[number]))) invalid('Fallback may handle only known quota, rate-limit or unavailable-provider outcomes.');
  result.fallbackOn = [...raw.fallbackOn] as DeliveryExecutionPolicy['fallbackOn'];
  if (!Number.isSafeInteger(raw.maxHandoffs) || result.maxHandoffs < 0 || result.maxHandoffs > 3) invalid('Use a bounded handoff limit from 0 through 3.');
  if (result.fallbackOn.length && (!result.fallbackProfiles.length || result.maxHandoffs === 0)) invalid('Automatic fallback requires an authorized target and a nonzero handoff limit.');
  if (raw.routing !== undefined) result.routing = routing(raw.routing, configured);
  return result;
}
/** All conditions in a rule must match; ordering is deterministic and recorded with the frozen selection. */
export function resolveDeliveryExecutionProfile(policy: DeliveryExecutionPolicy, requestedProfile?: string, input: DeliveryExecutionRoutingInput = {}): DeliveryExecutionResolution {
  const accepted = validateDeliveryExecutionPolicy(policy);
  return resolveValidatedDeliveryExecutionProfile(accepted, requestedProfile === undefined ? undefined : name(requestedProfile, 'Requested execution profile'), input);
}
export function deliveryExecutionProfileSelection(value: DeliveryExecutionProfile): ModelSelection {
  const accepted = profile(value);
  return validateModelSelection({ provider: accepted.provider, model: accepted.model, effort: accepted.effort, authenticationMode: accepted.authenticationMode });
}
