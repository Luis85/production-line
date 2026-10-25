import { DomainError } from '../../shared/errors.js';
import { deliveryGatePolicy, validateDeliveryPolicySnapshot } from './delivery-policy.js';
import { gateDigest, validateGatePolicy, type GatePolicy } from './request-gates.js';
import type { SharedFeatureRecord } from './shared-feature-state.js';

/** The effective execution gate is derived exclusively from the two frozen, independently validated policies. */
export function sharedFeaturePolicy(record: Pick<SharedFeatureRecord, 'workflow' | 'deliveryPolicy' | 'executionPolicy'>): { policy: GatePolicy; digest: string } {
  const policy = record.deliveryPolicy ? deliveryGatePolicy(record.workflow.policy, validateDeliveryPolicySnapshot(record.deliveryPolicy)) : record.workflow.policy;
  // Old non-delivery reservations retain their exact committed workflow identity and serialized claim hash.
  const digest = record.deliveryPolicy ? gateDigest(policy) : record.workflow.policyDigest;
  if (record.executionPolicy !== undefined && gateDigest(validateGatePolicy(record.executionPolicy)) !== digest)
    throw new DomainError('conflict', 'The frozen shared execution policy differs from its committed workflow and accepted delivery profile. Restore the retained reservation.');
  return { policy: structuredClone(record.executionPolicy ?? policy), digest };
}
