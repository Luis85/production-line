import type { ConsumptionStatus } from './consumption.js';

export type CapacityConsumption = Pick<ConsumptionStatus, 'blocked' | 'reason'>;
export interface RemoteAssignmentOccupancy { waiting: number | null; running: number | null; }
export interface WorkerCapacityContext {
  consumption: () => CapacityConsumption | null;
  remote: () => RemoteAssignmentOccupancy;
}
export interface WorkerCapacitySnapshot {
  schemaVersion: 1;
  capturedAt: string;
  execution: { limit: 1; inUse: 0 | 1; sessionId: string | null };
  /** The same occupancy used by local admission, including work being prepared or resumed. */
  local: { limit: number; used: number; remaining: number; overLimit: boolean };
  /** Remote leases are a separate buffer; they do not add execution slots or consume local places. */
  remote: RemoteAssignmentOccupancy & { extraQueuePlaces: number; accepted: number | null };
  starts: { paused: boolean; consumption: CapacityConsumption | null };
}
interface CapacityInput {
  capturedAt: string;
  currentSessionId: string | null;
  localUsed: number;
  settings: { paused: boolean; queueCapacity: number; orchestratorQueue: number };
  remote: RemoteAssignmentOccupancy;
  consumption: CapacityConsumption | null;
}
/** A synchronous observation of admission facts; retained notes and saved tasks are not queue occupancy. */
export function workerCapacitySnapshot(input: CapacityInput): WorkerCapacitySnapshot {
  const { settings, remote } = input;
  return {
    schemaVersion: 1, capturedAt: input.capturedAt,
    execution: { limit: 1, inUse: input.currentSessionId === null ? 0 : 1, sessionId: input.currentSessionId },
    local: { limit: settings.queueCapacity, used: input.localUsed, remaining: Math.max(0, settings.queueCapacity - input.localUsed), overLimit: input.localUsed > settings.queueCapacity },
    remote: { ...remote, extraQueuePlaces: settings.orchestratorQueue, accepted: remote.waiting === null || remote.running === null ? null : remote.waiting + remote.running },
    starts: { paused: settings.paused, consumption: input.consumption ? { blocked: input.consumption.blocked, reason: input.consumption.reason } : null },
  };
}
