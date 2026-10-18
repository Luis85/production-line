import { DomainError } from '../../shared/errors.js';

/** Worker-brokered delegation is an explicit grant, never a native provider capability. */
                                                                                                   
export const delegationLimits = Object.freeze({ maxChildren: 4, maxConcurrent: 2 });
export const defaultDelegationPolicy = ()                   => ({ enabled: false, ...delegationLimits });
export function validateDelegationPolicy(value         )                   {
  const policy = value                    ;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some(key => !['enabled', 'maxChildren', 'maxConcurrent'].includes(key))
    || typeof policy.enabled !== 'boolean' || !Number.isSafeInteger(policy.maxChildren) || policy.maxChildren < 1 || policy.maxChildren > delegationLimits.maxChildren
    || !Number.isSafeInteger(policy.maxConcurrent) || policy.maxConcurrent < 1 || policy.maxConcurrent > delegationLimits.maxConcurrent || policy.maxConcurrent > policy.maxChildren)
    throw new DomainError('invalid_input', 'Use a delegation grant with enabled, maxChildren (1–4) and maxConcurrent (1–2, no greater than maxChildren).');
  return { enabled: policy.enabled, maxChildren: policy.maxChildren, maxConcurrent: policy.maxConcurrent };
}
