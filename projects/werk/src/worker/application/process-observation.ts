import type { ProcessMeasurement, ProcessStatus, ServiceRecord } from './process-supervision.js';

export type ObservedProcessKind = 'provider' | 'tool' | 'mcp' | 'git' | 'other';
/** Identities only. Prompts, command lines, environments and paths do not belong here. */
export interface ProcessObservationContext {
  kind?: ObservedProcessKind; label?: string;
  featureRequestKey?: string | null; sessionId?: string | null; taskId?: string | null; runId?: string | null;
}
export interface ObservedProcessMeasurement extends Omit<ProcessMeasurement, 'scope'> { scope: 'owned_execution_process_group'; }
export interface ObservedProcessRecord {
  id: string; kind: ObservedProcessKind; label: string;
  featureRequestKey: string | null; sessionId: string | null; taskId: string | null; runId: string | null;
  state: 'running' | 'exited' | 'failed'; startedAt: string; endedAt: string | null; exitCode: number | null;
  /** Last live sample, never a complete lifetime total. */
  measurement: ObservedProcessMeasurement | null;
}
export interface ObservedProcessStatus {
  schemaVersion: 1; scope: 'worker_launched_finite_processes'; capturedAt: string; sampleIntervalMs: 1000;
  /** Completed records retained in memory. Live launches are always included. Restart clears this view. */
  retention: { limit: 100; scope: 'current_worker_process' };
  processes: ObservedProcessRecord[];
  /** Live groups only; partial sums never imply complete accounting of descendants. */
  summary: { active: number; total: number; rssBytes: number | null; cpuTotalMicros: number | null;
    measuredGroups: number; activeGroups: number; coverage: 'complete' | 'partial' | 'unavailable' };
}
export interface ServiceRecordView extends ServiceRecord { controls: { stop: boolean; restart: boolean; restartUnavailableReason: string | null }; }
export interface WorkerProcessesView {
  schemaVersion: 1; capturedAt: string;
  services: Omit<ProcessStatus, 'services'> & { services: ServiceRecordView[] };
  executions: ObservedProcessStatus;
}
export interface ProcessObservation {
  run<T>(context: ProcessObservationContext, operation: () => T): T;
  status(): Promise<ObservedProcessStatus>;
}
