import { DomainError } from '../../shared/errors.js';
import { gateDigest } from './request-gates.js';
import { validateModelSelection, type ModelSelection } from './model-selection.js';
import { validateDeliveryPolicySnapshot, type DeliveryPolicySnapshot } from './delivery-policy.js';
import { validateDeliveryExecutionSnapshot, type DeliveryExecutionSnapshot } from './delivery-execution-snapshot.js';
/** Trusted admission observations are frozen with the intake reservation, before an execution exists. */
export interface FeaturePreparation { selection?: ModelSelection; deliveryPolicy?: DeliveryPolicySnapshot; deliveryExecution?: DeliveryExecutionSnapshot; }
export function validateFeaturePreparation(value: FeaturePreparation): void {
  if (value.selection) validateModelSelection(value.selection);
  if (value.deliveryPolicy) validateDeliveryPolicySnapshot(value.deliveryPolicy);
  if (value.deliveryExecution) {
    const execution = validateDeliveryExecutionSnapshot(value.deliveryExecution);
    if (!value.deliveryPolicy || gateDigest(value.deliveryPolicy.configuration.execution) !== gateDigest(execution.policy) || gateDigest(value.selection) !== gateDigest(execution.selection))
      throw new DomainError('conflict', 'The retained execution profile differs from its accepted policy or selection. Restore the private reservation.');
  }
}
