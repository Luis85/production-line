import { defaultDeliveryProjectPolicy, validateDeliveryProjectPolicy } from './delivery-policy.js';

/** Explicit starter for newly installed projects; never migrates old absent-file authority. */
export function newDeliveryProjectPolicy() {
  const configuration = defaultDeliveryProjectPolicy();
  configuration.version = 2;
  for (const profile of configuration.profiles) profile.readiness = {
    assessment: 'required', assumptions: 'explicit', requiredReferences: [],
    maxEstimatedMinutes: profile.id === 'lightweight' ? 30 : 240,
  };
  return validateDeliveryProjectPolicy(configuration);
}
