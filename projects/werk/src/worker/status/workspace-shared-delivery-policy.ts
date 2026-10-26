import { DomainError } from '../../shared/errors.js';
import { gateDigest } from '../application/request-gates.js';
import { validateDeliveryPolicySnapshot } from '../application/delivery-policy.js';
import type { SharedFeatureRecord } from '../application/shared-feature-state.js';
import { readDeliveryPolicy } from '../infrastructure/delivery-policy.js';

/** Answers advance the execution source, while the claimed configuration and selected profile remain authority. */
export async function sharedDeliveryPolicyForSource(record: SharedFeatureRecord, repository: string, signal: AbortSignal) {
  if (!record.deliveryPolicy) return undefined;
  const retained = validateDeliveryPolicySnapshot(record.deliveryPolicy);
  if (retained.baseline === record.sourceCommit) return retained;
  const committed = await readDeliveryPolicy(repository, signal, retained.profile.id, record.sourceCommit);
  if (committed.configurationDigest !== retained.configurationDigest || gateDigest(committed.profile) !== gateDigest(retained.profile))
    throw new DomainError('conflict', 'The answered Feature Request changes its frozen delivery policy or quality profile. Restore the originally approved committed configuration, or submit a new Feature Request for the changed policy.');
  return committed;
}
