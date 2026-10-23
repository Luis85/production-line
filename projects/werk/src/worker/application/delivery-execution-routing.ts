import { DomainError } from '../../shared/errors.js';
import type { DeliveryExecutionPolicy, DeliveryExecutionResolution, DeliveryExecutionRoutingInput } from './delivery-execution-policy.js';
/** Selection over an already validated project policy; reusable by the server and preview UI. */
export function resolveValidatedDeliveryExecutionProfile(accepted: DeliveryExecutionPolicy, requestedProfile?: string, input: DeliveryExecutionRoutingInput = {}): DeliveryExecutionResolution {
  if (requestedProfile !== undefined) {
    const id = requestedProfile;
    if (id !== accepted.defaultProfile && !accepted.allowedOverrides.includes(id)) throw new DomainError('forbidden', 'This execution profile is not allowed as a request override.');
    return { profile: structuredClone(accepted.profiles.find(item => item.id === id)!), source: 'override' };
  }
  const rule = accepted.routing?.find(item =>
    (!item.qualityProfiles || input.qualityProfile !== undefined && item.qualityProfiles.includes(input.qualityProfile))
    && (!item.modes || input.mode !== undefined && item.modes.includes(input.mode))
    && (!item.priorities || input.priority !== undefined && item.priorities.includes(input.priority as 0 | 1 | 2 | 3)));
  return { profile: structuredClone(accepted.profiles.find(item => item.id === (rule?.profile ?? accepted.defaultProfile))!), source: rule ? 'rule' : 'default', ...(rule ? { ruleId: rule.id } : {}) };
}
