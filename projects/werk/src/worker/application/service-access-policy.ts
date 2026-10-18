import { DomainError } from '../../shared/errors.js';
import type { ServicePreset } from './process-supervision.js';
import { serviceLimits, validateServicePreset } from './service-policy.js';

/** Long-running service access is separate from finite command grants. */
export interface ServicePolicy { enabled: boolean; maxActive: number; presets: ServicePreset[]; }
export const defaultServicePolicy = (): ServicePolicy => ({ enabled: false, maxActive: serviceLimits.defaultActive, presets: [] });
export function validateServicePolicy(value: unknown): ServicePolicy {
  const policy = value as ServicePolicy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)
    || Object.keys(policy).some(key => !['enabled', 'maxActive', 'presets'].includes(key))
    || typeof policy.enabled !== 'boolean' || !Number.isSafeInteger(policy.maxActive)
    || policy.maxActive < 1 || policy.maxActive > serviceLimits.maximumActive
    || !Array.isArray(policy.presets) || policy.presets.length > serviceLimits.maximumPresets) {
    throw new DomainError('invalid_input', 'Configure service access with an explicit grant, 1–16 active services and at most 16 named presets.');
  }
  const presets = policy.presets.map(validateServicePreset);
  if (new Set(presets.map(preset => preset.id)).size !== presets.length) throw new DomainError('invalid_input', 'Service preset IDs must be unique.');
  return { enabled: policy.enabled, maxActive: policy.maxActive, presets };
}
