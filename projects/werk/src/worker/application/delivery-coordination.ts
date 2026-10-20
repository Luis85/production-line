import { DomainError } from '../../shared/errors.js';
import { object } from '../../shared/contracts.js';
/** Project authority may lower, never increase, the machine execution ceiling. */
export interface DeliveryCoordinationPolicy {
  maxActiveRequests: number;
  dependencyPlanning: 'accepted_baseline' | 'topological';
}
export const MAX_WORKER_PARALLEL = 8;
export function validateDeliveryCoordinationPolicy(value: unknown): DeliveryCoordinationPolicy {
  const raw = object(value, 'Delivery coordination', ['maxActiveRequests', 'dependencyPlanning']);
  if (!Number.isSafeInteger(raw.maxActiveRequests) || Number(raw.maxActiveRequests) < 1 || Number(raw.maxActiveRequests) > MAX_WORKER_PARALLEL)
    throw new DomainError('invalid_input', 'Project concurrency must be an integer from 1 to 8.');
  if (raw.dependencyPlanning !== 'accepted_baseline' && raw.dependencyPlanning !== 'topological')
    throw new DomainError('invalid_input', 'Choose accepted_baseline or topological dependency planning.');
  return { maxActiveRequests: Number(raw.maxActiveRequests), dependencyPlanning: raw.dependencyPlanning };
}
export function effectiveProjectConcurrency(policy: DeliveryCoordinationPolicy | undefined, machineLimit: number): number {
  return Math.min(Math.max(1, Math.min(MAX_WORKER_PARALLEL, Math.trunc(machineLimit) || 1)), policy?.maxActiveRequests ?? 1);
}
