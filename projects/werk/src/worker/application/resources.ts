import { DomainError } from '../../shared/errors.js';

export interface ResourcePolicy {
  memoryPercent: number;
  heapPercent: number;
  cpuPercent: number;
  cpuSustainMs: number;
  diskFreeBytes: number;
  diskFreePercent: number;
  longRunningMs: number;
}
export const defaultResourcePolicy = (): ResourcePolicy => ({ memoryPercent: 85, heapPercent: 90, cpuPercent: 90, cpuSustainMs: 30000, diskFreeBytes: 268435456, diskFreePercent: 5, longRunningMs: 3600000 });
export function validateResourcePolicy(input: unknown): ResourcePolicy {
  const bounds: Record<keyof ResourcePolicy, [number, number]> = { memoryPercent: [1, 100], heapPercent: [1, 100], cpuPercent: [1, 100], cpuSustainMs: [1000, 3600000], diskFreeBytes: [0, 1099511627776], diskFreePercent: [0, 100], longRunningMs: [1000, 86400000] };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !(key in bounds))) throw new DomainError('invalid_input', 'Use the documented resource policy fields.');
  const value = input as ResourcePolicy;
  for (const [key, [minimum, maximum]] of Object.entries(bounds)) {
    const number = value[key as keyof ResourcePolicy];
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new DomainError('invalid_input', `Resource policy ${key} must be an integer between ${minimum} and ${maximum}.`);
  }
  return { ...value };
}
export interface ActiveExecution { projectId?: string | null; sessionId: string; startedAt: number; monotonicStartedAt: number; }
export interface ResourceReading {
  processId: number;
  processStartId: string;
  monotonicMs: number;
  cpuTotalMicros: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapLimitBytes: number;
  effectiveMemoryLimitBytes: number | null;
  availableMemoryBytes: number | null;
  cpuCapacityCores: number;
  diskAvailableBytes: number | null;
  diskTotalBytes: number | null;
  unavailable: string[];
}
export interface ResourceSnapshot extends Omit<ResourceReading, 'monotonicMs' | 'cpuTotalMicros'> {
  capturedAt: string;
  scope: 'worker_node_process';
  cpuCapacityBasis: 'available_parallelism';
  cpuCores: number | null;
  cpuPercent: number | null;
  active: { sessionId: string; startedAt: string; elapsedMs: number } | null;
  activeExecutions?: Array<{ sessionId: string; projectId: string | null; startedAt: string; elapsedMs: number }>;
}
export type ResourceAlertCode = 'memory' | 'heap' | 'cpu' | 'disk' | 'long_running';
export interface ResourceAlert {
  id: string;
  code: ResourceAlertCode;
  severity: 'warning';
  openedAt: string;
  sessionId?: string;
  observed: number;
  threshold: number;
  executionStartedAt?: string;
}
export interface ResourceEvent {
  schemaVersion: 1;
  sequence: number;
  id: string;
  alertId: string;
  code: ResourceAlertCode;
  type: 'opened' | 'resolved';
  at: string;
  reason: 'threshold' | 'recovered' | 'execution_finished' | 'worker_restarted';
  observed: number;
  threshold: number;
  sessionId?: string;
}
export interface ResourceEventPage { schemaVersion: 1; events: ResourceEvent[]; nextAfter: number; hasMore: boolean; oldestAvailableSequence: number | null; gap: boolean; }
export interface ResourceStatus {
  schemaVersion: 1;
  sampleIntervalMs: number;
  policy: ResourcePolicy;
  snapshot: ResourceSnapshot | null;
  alerts: ResourceAlert[];
  persistenceError: boolean;
  sampleError: boolean;
  sampleErrorReason: 'measurement_unavailable' | 'invalid_measurement' | null;
}
export interface ResourceEventStore {
  init(): Promise<void>;
  active(): ResourceAlert[];
  transition(alert: ResourceAlert, type: ResourceEvent['type'], reason: ResourceEvent['reason'], at: string): void;
  events(after?: number, limit?: number): ResourceEventPage;
  close(): void;
}
