import type { DeliveryPolicySnapshot } from '../application/delivery-policy';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Older retained input can lack this snapshot; the UI must not invent an effective policy. */
export function acceptedDeliveryPolicy(context: unknown): DeliveryPolicySnapshot | null {
  if (!record(context) || !record(context.deliveryPolicy)) return null;
  const value = context.deliveryPolicy;
  if (value.schemaVersion !== 1 || typeof value.baseline !== 'string' || typeof value.configurationDigest !== 'string' ||
    !record(value.profile) || !record(value.configuration) || typeof value.profile.id !== 'string' ||
    !Number.isSafeInteger(value.profile.maxRepairAttempts) || typeof value.configuration.reviewDirectory !== 'string' ||
    !Array.isArray(value.profile.verificationInputs) || value.profile.verificationInputs.some(path => typeof path !== 'string')) return null;
  return value as unknown as DeliveryPolicySnapshot;
}
