import { validateDeliveryCheckPacks, validateDeliveryCheckPackReferences, selectedDeliveryCheckPacks, type DeliveryCheckPack } from './delivery-check-packs.js';
import { validateDeliveryRetention, type DeliveryRetentionPolicy } from './delivery-retention.js';
import { validateDeliveryReadinessPolicy, type DeliveryReadinessPolicy } from './delivery-readiness.js';
import { validateDeliveryCriterionExceptionPolicy, type DeliveryCriterionExceptionPolicy } from './delivery-criterion-decisions.js';
import { validateDeliveryExecutionPolicy, type DeliveryExecutionPolicy } from './delivery-execution-policy.js';
import { validateRemoteDeliveryPolicy, type RemoteDeliveryPolicy } from './remote-delivery-policy.js';
import { validateDeliveryCoordinationPolicy, type DeliveryCoordinationPolicy } from './delivery-coordination.js';
import { validateDeliveryBehaviorLibrary, type DeliveryBehaviorLibrary } from './delivery-behavior-policy.js';
import { DomainError } from '../../shared/errors.js';
import { object } from '../../shared/contracts.js';
import { featureWorkflowPath } from './feature-workflow.js';
import { gateDigest, validateGatePolicy, type GatePolicy } from './request-gates.js';

export const deliveryPolicyPath = '.werk/delivery-policy.json';
export interface DeliveryQualityProfile {
  id: string; minimumCriteria: number; minimumMessageLength: number;
  maxRepairAttempts: number; verificationInputs: string[];
  readiness?: DeliveryReadinessPolicy; exceptions?: DeliveryCriterionExceptionPolicy; checkPacks?: string[];
}
export interface DeliveryProjectPolicy {
  schemaVersion: 1; version: number; defaultProfile: string;
  reviewDirectory: string; profiles: DeliveryQualityProfile[]; checkPacks?: DeliveryCheckPack[];
  execution?: DeliveryExecutionPolicy; remoteDelivery?: RemoteDeliveryPolicy;
  coordination?: DeliveryCoordinationPolicy; behaviors?: DeliveryBehaviorLibrary; retention?: DeliveryRetentionPolicy;
}
export interface DeliveryPolicySnapshot {
  schemaVersion: 1; baseline: string; configurationDigest: string;
  configuration: DeliveryProjectPolicy; profile: DeliveryQualityProfile;
}
function invalid(message: string): never { throw new DomainError('invalid_input', message); }
export function verificationInputs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 65 || value.some(item => typeof item !== 'string')) invalid('Verification inputs require at most 64 configured paths plus the mandatory delivery policy file.');
  const paths = (value as string[]).map(path => {
    const folder = path.endsWith('/');
    return featureWorkflowPath(folder ? path.slice(0, -1) : path, 'Verification input') + (folder ? '/' : '');
  });
  if (new Set(paths.map(path => path.toLowerCase())).size !== paths.length) invalid('Verification input paths must be unique.');
  const configured = paths.filter(path => path.toLowerCase() !== deliveryPolicyPath.toLowerCase());
  if (configured.length > 64) invalid('Use at most 64 configured verification paths.');
  return [...configured, deliveryPolicyPath];
}
export function defaultDeliveryProjectPolicy(): DeliveryProjectPolicy {
  const inputs = [deliveryPolicyPath, 'tests/', 'test/', 'scripts/', 'package.json', 'package-lock.json', 'tsconfig.json'];
  return { schemaVersion: 1, version: 1, defaultProfile: 'feature', reviewDirectory: 'feature-reviews', profiles: [
    { id: 'feature', minimumCriteria: 1, minimumMessageLength: 20, maxRepairAttempts: 2, verificationInputs: [...inputs] },
    { id: 'lightweight', minimumCriteria: 0, minimumMessageLength: 1, maxRepairAttempts: 1, verificationInputs: [...inputs] },
  ] };
}
export function validateDeliveryProjectPolicy(value: unknown): DeliveryProjectPolicy {
  const raw = object(value, 'Delivery project policy', ['schemaVersion', 'version', 'defaultProfile', 'reviewDirectory', 'profiles', 'execution', 'remoteDelivery', 'coordination', 'behaviors', 'retention', 'checkPacks']);
  if (raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.version) || Number(raw.version) < 1 || !Array.isArray(raw.profiles) || raw.profiles.length < 2 || raw.profiles.length > 16) invalid('Delivery policy requires schemaVersion 1, a positive version and 2–16 named profiles.');
  const profiles = raw.profiles.map(item => {
    const profile = object(item, 'Quality profile', ['id', 'minimumCriteria', 'minimumMessageLength', 'maxRepairAttempts', 'verificationInputs', 'readiness', 'exceptions', 'checkPacks']);
    if (typeof profile.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(profile.id)) invalid('Quality profile IDs must be lowercase names.');
    for (const [key, maximum] of [['minimumCriteria', 64], ['minimumMessageLength', 8000], ['maxRepairAttempts', 3]] as const)
      if (!Number.isSafeInteger(profile[key]) || Number(profile[key]) < 0 || Number(profile[key]) > maximum) invalid('Quality profile input and repair limits are outside supported bounds.');
    return { id: profile.id, minimumCriteria: Number(profile.minimumCriteria), minimumMessageLength: Number(profile.minimumMessageLength), maxRepairAttempts: Number(profile.maxRepairAttempts), verificationInputs: verificationInputs(profile.verificationInputs),
      ...(profile.checkPacks === undefined ? {} : { checkPacks: validateDeliveryCheckPackReferences(profile.checkPacks) }),
      ...(profile.readiness === undefined ? {} : { readiness: validateDeliveryReadinessPolicy(profile.readiness) }),
      ...(profile.exceptions === undefined ? {} : { exceptions: validateDeliveryCriterionExceptionPolicy(profile.exceptions) }),
    };
  });
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length || !['feature', 'lightweight'].every(id => profiles.some(profile => profile.id === id))) invalid('Delivery policy must contain unique feature and lightweight profiles.');
  if (typeof raw.defaultProfile !== 'string' || !profiles.some(profile => profile.id === raw.defaultProfile)) invalid('The default quality profile must be configured.');
  const reviewDirectory = featureWorkflowPath(raw.reviewDirectory, 'Review directory');
  if (reviewDirectory.toLowerCase().split('/').includes('.werk')) invalid('Review notes must be outside private worker state.');
  const checkPacks = raw.checkPacks === undefined ? undefined : validateDeliveryCheckPacks(raw.checkPacks);
  for (const profile of profiles) selectedDeliveryCheckPacks({ checkPacks }, profile);
  const execution = raw.execution === undefined ? undefined : validateDeliveryExecutionPolicy(raw.execution);
  // Cross-section references belong to the complete project policy, shared by draft, approval and admission.
  const qualityProfiles = new Set(profiles.map(profile => profile.id));
  for (const rule of execution?.routing ?? []) for (const id of rule.qualityProfiles ?? [])
    if (!qualityProfiles.has(id)) invalid(`Execution routing rule ${rule.id} references unknown quality profile ${id}.`);
  return { schemaVersion: 1, version: Number(raw.version), defaultProfile: raw.defaultProfile, reviewDirectory, profiles,
    ...(checkPacks === undefined ? {} : { checkPacks }),
    ...(execution === undefined ? {} : { execution }),
    ...(raw.remoteDelivery === undefined ? {} : { remoteDelivery: validateRemoteDeliveryPolicy(raw.remoteDelivery) }),
    ...(raw.coordination === undefined ? {} : { coordination: validateDeliveryCoordinationPolicy(raw.coordination) }),
    ...(raw.retention === undefined ? {} : { retention: validateDeliveryRetention(raw.retention) }),
    ...(raw.behaviors === undefined ? {} : { behaviors: validateDeliveryBehaviorLibrary(raw.behaviors) }),
  };
}
/** Selected profiles add conditions to trusted existing gates; a request cannot remove a mandatory rule. */
export function deliveryGatePolicy(base: GatePolicy, snapshot: DeliveryPolicySnapshot): GatePolicy {
  const policy = validateGatePolicy(base), profile = snapshot.profile;
  policy.id = 'delivery-' + profile.id; policy.version = snapshot.configuration.version;
  if (profile.readiness) policy.reviewer.enabled = true;
  for (const kind of ['chat', 'patch'] as const) {
    const additions = [
      { id: 'delivery-profile-message', fact: 'input.messageLength' as const, op: 'gte' as const, value: profile.minimumMessageLength },
      { id: 'delivery-profile-criteria', fact: 'input.criteriaCount' as const, op: 'gte' as const, value: profile.minimumCriteria },
    ];
    if (policy.ready[kind].some(rule => additions.some(item => item.id === rule.id))) invalid('Gate IDs beginning delivery-profile- are reserved for quality profiles.');
    policy.ready[kind].push(...additions);
  }
  return validateGatePolicy(policy);
}
export function deliveryPolicySnapshot(configuration: DeliveryProjectPolicy, baseline: string, profileId?: string): DeliveryPolicySnapshot {
  configuration = validateDeliveryProjectPolicy(configuration);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseline)) invalid('A delivery policy snapshot requires an immutable baseline commit.');
  const profile = configuration.profiles.find(item => item.id === (profileId ?? configuration.defaultProfile));
  if (!profile) invalid('The request quality_profile does not identify a configured project profile.');
  return { schemaVersion: 1, baseline, configurationDigest: gateDigest(configuration), configuration: structuredClone(configuration), profile: structuredClone(profile) };
}

export function validateDeliveryPolicySnapshot(value: unknown): DeliveryPolicySnapshot {
  const raw = object(value, 'Delivery policy snapshot', ['schemaVersion', 'baseline', 'configurationDigest', 'configuration', 'profile']);
  const profile = object(raw.profile, 'Selected quality profile', ['id', 'minimumCriteria', 'minimumMessageLength', 'maxRepairAttempts', 'verificationInputs', 'readiness', 'exceptions', 'checkPacks']);
  if (raw.schemaVersion !== 1 || typeof raw.baseline !== 'string' || typeof profile.id !== 'string') invalid('Invalid delivery policy snapshot.');
  const snapshot = deliveryPolicySnapshot(validateDeliveryProjectPolicy(raw.configuration), raw.baseline, profile.id);
  if (snapshot.configurationDigest !== raw.configurationDigest || gateDigest(snapshot.profile) !== gateDigest(raw.profile)) invalid('The retained quality policy no longer matches its accepted snapshot.');
  return snapshot;
}
