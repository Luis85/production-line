import type { ToolWorktreeIdentity } from './tool-runtime.js';

/** Explicit operator grants. An ordinary command grant never authorizes a background service. */
export interface ServicePreset {
  id: string; name: string; executable: string; args: string[]; enabled: boolean;
  ttlMs: number; startupTimeoutMs: number; readyText?: string;
  restart: { maxAttempts: number; backoffMs: number };
}
export interface ServiceScope {
  featureRequestKey: string; sessionId: string; taskId?: string; runId?: string;
  worktree: string; worktreeIdentity: ToolWorktreeIdentity;
}
export type ServiceState = 'starting' | 'running' | 'restarting' | 'stopping' | 'stopped' | 'failed' | 'interrupted';
export type ServiceStopReason = 'operator' | 'feature_ended' | 'revoked' | 'shutdown' | 'ttl' | 'startup_timeout' | 'storage_failed';
export interface ProcessMeasurement {
  scope: 'owned_service_process_group'; platform: string; capturedAt: string;
  cpuTotalMicros: number | null; rssBytes: number | null; processCount: number | null;
  coverage: 'complete_group' | 'unavailable'; unavailableReason: string | null;
}
export interface ServiceExit { code: number | null; reason: 'exit' | 'spawn_failed' | 'host_lost' | 'parent_lost' | ServiceStopReason; }
export type ServiceHostEvent = { type: 'output'; stream: 'stdout' | 'stderr'; text: string } | { type: 'measurement'; value: ProcessMeasurement };
export interface ServiceHostHandle { closed: Promise<ServiceExit>; stop(reason: ServiceStopReason): Promise<void>; }
export interface ServiceHostPort {
  start(input: { preset: ServicePreset; scope: ServiceScope; expiresAt: string; onEvent(event: ServiceHostEvent): void }): Promise<ServiceHostHandle>;
}
export interface ServiceRecord {
  id: string; revision: number; presetId: string; name: string;
  featureRequestKey: string; sessionId: string; taskId?: string; runId?: string;
  state: ServiceState; generation: number; restartCount: number; restartLimit: number;
  createdAt: string; startedAt: string | null; endedAt: string | null; expiresAt: string;
  readiness: 'not_configured' | 'waiting' | 'reported' | 'timed_out'; readyAt: string | null;
  lastExit: ServiceExit | null; error: string | null; measurement: ProcessMeasurement | null;
}
export interface ServiceLog { sequence: number; at: string; stream: 'stdout' | 'stderr'; text: string; }
export interface StoredService {
  record: ServiceRecord; scope: ServiceScope; presetFingerprint: string; operationId: string;
  logs: ServiceLog[]; nextLogSequence: number;
  commands?: Array<{ operationId: string; action: 'stop' | 'restart'; expectedRevision: number }>;
}
export interface ProcessJournal { load(): Promise<StoredService[]>; save(services: StoredService[]): Promise<void>; }
export interface ProcessStatus {
  schemaVersion: 1; scope: 'worker_owned_services'; capturedAt: string; sampleIntervalMs: number;
  services: ServiceRecord[]; capacity: { active: number; maximum: number };
  summary: { running: number; starting: number; failed: number; restarts: number; rssBytes: number | null; cpuTotalMicros: number | null; measuredGroups: number; activeGroups: number; coverage: 'complete' | 'partial' | 'unavailable' };
  persistenceError: boolean;
}
export interface ServiceCommand { id: string; expectedRevision: number; operationId: string; }
export interface ServiceStart { operationId: string; presetId: string; scope: ServiceScope; }
export interface ProcessSupervisorOptions {
  journal: ProcessJournal; host: ServiceHostPort;
  presets(): readonly ServicePreset[];
  /** Revalidate the canonical FR, repository and pinned worktree before every actual start. */
  validateScope(scope: ServiceScope): Promise<void>;
  maxActive?: number | (() => number); now?: () => number;
}
