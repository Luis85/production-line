import { object } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import { validateSnapshot, type DefinitionSnapshot } from './definitions.js';
import { validateModelSelection, type ModelSelection } from './model-selection.js';
import { gateDigest } from './request-gates.js';
import { validateDeliveryExecutionPolicy, type DeliveryExecutionPolicy, type DeliveryExecutionProfile, type DeliveryExecutionResolution } from './delivery-execution-policy.js';
export interface DeliveryExecutionProfileSnapshot { profileId: string; selection: ModelSelection; definition?: DefinitionSnapshot; }
export interface DeliveryExecutionSnapshot { policy: DeliveryExecutionPolicy; resolution: DeliveryExecutionResolution; selection: ModelSelection; definition?: DefinitionSnapshot; profileSnapshots: DeliveryExecutionProfileSnapshot[]; }
function invalid(message: string): never { throw new DomainError('invalid_input', message); }
function validateProfileSnapshot(value: unknown, profile: DeliveryExecutionProfile): DeliveryExecutionProfileSnapshot {
  const raw = object(value, 'Frozen execution profile', ['profileId', 'selection', 'definition']);
  if (raw.profileId !== profile.id) invalid('Frozen execution profile identity does not match its policy.');
  const selection = validateModelSelection(raw.selection);
  let definition: DefinitionSnapshot | undefined;
  if (raw.definition !== undefined) { validateSnapshot(raw.definition); definition = structuredClone(raw.definition); }
  if (!!definition !== !!profile.definitionRef || definition && (definition.ref !== profile.definitionRef || definition.agent !== (profile.agent ?? 'root') || definition.adapted && profile.useInstructionsOnly !== true)) invalid('Execution profile instructions must match the frozen imported definition and approved adaptation.');
  if (selection.provider !== profile.provider || selection.authenticationMode !== profile.authenticationMode || selection.effort !== profile.effort || selection.model !== (profile.model || definition?.model || '')) invalid('Frozen execution selection does not match its authorized profile.');
  return { profileId: profile.id, selection, ...(definition ? { definition } : {}) };
}
/** Every later reviewer/fallback uses accepted instructions; no mutable definition lookup is permitted. */
export function validateDeliveryExecutionSnapshot(value: unknown): DeliveryExecutionSnapshot {
  const raw = object(value, 'Delivery execution snapshot', ['policy', 'resolution', 'selection', 'definition', 'profileSnapshots']);
  const policy = validateDeliveryExecutionPolicy(raw.policy);
  const resolution = object(raw.resolution, 'Execution routing receipt', ['profile', 'source', 'ruleId']);
  const selected = policy.profiles.find(profile => gateDigest(profile) === gateDigest(resolution.profile));
  if (!selected || resolution.source !== 'default' && resolution.source !== 'rule' && resolution.source !== 'override') invalid('Execution routing must identify an authorized frozen profile.');
  if (resolution.source === 'default' && selected.id !== policy.defaultProfile || resolution.source === 'override' && selected.id !== policy.defaultProfile && !policy.allowedOverrides.includes(selected.id)) invalid('Execution profile override is not authorized.');
  if (resolution.source === 'rule' ? !policy.routing?.some(rule => rule.id === resolution.ruleId && rule.profile === selected.id) : resolution.ruleId !== undefined) invalid('Execution routing rule receipt does not match its policy.');
  if (!Array.isArray(raw.profileSnapshots) || raw.profileSnapshots.length !== policy.profiles.length) invalid('Freeze every configured execution profile before accepting work.');
  const snapshots = raw.profileSnapshots as unknown[];
  const profileSnapshots = policy.profiles.map(profile => {
    const entries = snapshots.filter(value => value && typeof value === 'object' && (value as {profileId?:unknown}).profileId === profile.id);
    if (entries.length !== 1) invalid('Frozen execution profiles must be complete and unique.');
    return validateProfileSnapshot(entries[0], profile);
  });
  const implementation = validateProfileSnapshot({ profileId: selected.id, selection: raw.selection, ...(raw.definition === undefined ? {} : { definition: raw.definition }) }, selected);
  if (gateDigest(implementation) !== gateDigest(profileSnapshots.find(profile => profile.profileId === selected.id))) invalid('Implementation profile differs from its frozen catalog entry.');
  return { policy, resolution: { profile: structuredClone(selected), source: resolution.source as DeliveryExecutionResolution['source'], ...(resolution.ruleId === undefined ? {} : { ruleId: resolution.ruleId as string }) }, selection: implementation.selection, ...(implementation.definition ? { definition: implementation.definition } : {}), profileSnapshots };
}
