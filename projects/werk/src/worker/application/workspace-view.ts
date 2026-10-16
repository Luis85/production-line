import type { ConsumptionPolicy } from './consumption.js';
import type { ProviderConnection } from './provider-contract.js';
import type { RepositoryConfiguration } from './repositories.js';
import type { ResourcePolicy } from './resources.js';
import type { ExecutionPolicy } from './execution-policy.js';
import type { SessionRecord } from './sessions.js';
import type { LocalTask, LocalTaskPreparation } from './local-tasks.js';
import type { InteractionView } from './interactions.js';
import type { RequestPhase } from './request-gates.js';

/** Public snapshots deliberately exclude provider credentials and approved file contents. */
export interface WorkerBoardSettings {
  paused: boolean; maxParallel: number; queueCapacity: number; orchestratorQueue: number; order: 'fifo' | 'priority';
}
export interface WorkerSettingsView {
  repositories: RepositoryConfiguration;
  executionSource: 'environment' | 'saved_settings' | 'default';
  resources: ResourcePolicy;
  consumption: ConsumptionPolicy;
  execution: ExecutionPolicy;
  providers: Array<Omit<ProviderConnection, 'apiKey'> & { label: string; configured: boolean; hasApiKey: boolean; authentication: string }>;
  connection: { enabled: boolean; url: string; hasEnrollmentToken: boolean };
  board: WorkerBoardSettings;
}
export interface SessionView {
  selected: string;
  execution: { currentSessionId: string | null; queued: number; maxParallel: number };
  records: Array<SessionRecord & { requestId?: string; requestPhase?: RequestPhase; requestRevision?: number; status: string; interaction: InteractionView; busy: boolean; messages: number }>;
}
export interface LocalTaskboardView {
  settings: WorkerBoardSettings;
  tasks: Array<Omit<LocalTask, 'files' | 'instruction' | 'patch'> & { files: Array<{ path: string; sha256: string }>; hasPatch: boolean; interaction: InteractionView; requestPhase?: RequestPhase; requestRevision?: number }>;
  /** Background admissions (`background: true`) until their task appears, or failed with a reason. Absent from older workers. */
  preparations?: LocalTaskPreparation[];
  persistenceError: boolean;
  running: number;
}
