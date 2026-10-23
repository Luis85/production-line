import { object } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
/** Only temporary service logs expire. Delivery receipts, journals and unfinished changes remain retained. */
export interface DeliveryRetentionPolicy {
  temporaryLogHours: number;
  acceptedEvidence: 'preserve';
  unacceptedWork: 'preserve';
}
export const defaultDeliveryRetention = (): DeliveryRetentionPolicy => ({ temporaryLogHours: 168, acceptedEvidence: 'preserve', unacceptedWork: 'preserve' });
export function validateDeliveryRetention(value: unknown): DeliveryRetentionPolicy {
  const input = object(value, 'Delivery retention', ['temporaryLogHours', 'acceptedEvidence', 'unacceptedWork']);
  if (!Number.isSafeInteger(input.temporaryLogHours) || Number(input.temporaryLogHours) < 0 || Number(input.temporaryLogHours) > 720 || input.acceptedEvidence !== 'preserve' || input.unacceptedWork !== 'preserve')
    throw new DomainError('invalid_input', 'Retention requires temporaryLogHours from 0 to 720 and preserve for acceptedEvidence and unacceptedWork. Zero disables stored temporary service logs.');
  return { temporaryLogHours: Number(input.temporaryLogHours), acceptedEvidence: 'preserve', unacceptedWork: 'preserve' };
}
