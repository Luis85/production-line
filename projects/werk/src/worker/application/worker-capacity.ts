import type { ActiveExecutionPermit, ReservedExecutionPermit } from './serial-executor.js';
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
  execution: { limit: number; inUse: number; sessionId: string | null;
    sessions?: Array<{ sessionId: string; projectId: string | null; startedAt: string }>;
    unresolved?: Array<{ sessionId: string; projectId: string | null }>;
    projects?: Array<{ projectId: string; limit: number; inUse: number }>;
  };
  /** The same occupancy used by local admission, including work being prepared or resumed. */
  local: { limit: number; used: number; remaining: number; overLimit: boolean };
  /** Remote leases are a separate buffer; they do not add execution slots or consume local places. */
  remote: RemoteAssignmentOccupancy & { extraQueuePlaces: number; accepted: number | null };
  starts: { paused: boolean; consumption: CapacityConsumption | null };
}
interface CapacityInput {
  capturedAt: string;
  currentSessionId: string | null;
  activeSessions?: ActiveExecutionPermit[];
  reservedExecutions?: ReservedExecutionPermit[];
  localUsed: number;
  settings: { paused: boolean; queueCapacity: number; orchestratorQueue: number; maxParallel?: number };
  remote: RemoteAssignmentOccupancy;
  consumption: CapacityConsumption | null;
}
/** A synchronous observation of admission facts; retained notes and saved tasks are not queue occupancy. */
export function workerCapacitySnapshot(input: CapacityInput): WorkerCapacitySnapshot {
  const { settings, remote } = input;
  const limit = settings.maxParallel ?? 1;
  const active = input.activeSessions;
  const reserved = input.reservedExecutions?.filter(item => !active?.some(live => live.sessionId === item.sessionId)) ?? [];
  const occupied = [...(active ?? []), ...reserved];
  const projects = [...new Set(occupied.flatMap(item => item.projectId ? [item.projectId] : []))].map(projectId => {
    const members = occupied.filter(item => item.projectId === projectId);
    return { projectId, limit: Math.min(limit, ...members.map(item => item.projectLimit)), inUse: members.length };
  });
  return {
    schemaVersion: 1, capturedAt: input.capturedAt,
    execution: { limit, inUse: (active?.length ?? (input.currentSessionId === null ? 0 : 1)) + reserved.length, sessionId: input.currentSessionId,
      ...(input.reservedExecutions ? { unresolved: reserved.map(({ sessionId, projectId }) => ({ sessionId, projectId })) } : {}),
      ...(active ? { sessions: active.map(({ sessionId, projectId, startedAt }) => ({ sessionId, projectId, startedAt: new Date(startedAt).toISOString() })), projects } : {}),
    },
    local: { limit: settings.queueCapacity, used: input.localUsed, remaining: Math.max(0, settings.queueCapacity - input.localUsed), overLimit: input.localUsed > settings.queueCapacity },
    remote: { ...remote, extraQueuePlaces: settings.orchestratorQueue, accepted: remote.waiting === null || remote.running === null ? null : remote.waiting + remote.running },
    starts: { paused: settings.paused, consumption: input.consumption ? { blocked: input.consumption.blocked, reason: input.consumption.reason } : null },
  };
}
