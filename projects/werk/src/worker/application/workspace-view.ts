import type { ModelSelection, ModelEffort } from './model-selection.js';
import type { FeatureRequestReference } from './feature-request-reference.js';
import type { FeatureTrackingRecord, FeatureTrackingStatus } from './feature-tracking.js';
import type { WorkerCapacitySnapshot } from './worker-capacity.js';
import type { ConsumptionPolicy } from './consumption.js';
import type { ProviderConnection } from './provider-contract.js';
import type { RepositoryConfiguration } from './repositories.js';
import type { ResourcePolicy } from './resources.js';
import type { ExecutionPolicy } from './execution-policy.js';
import type { SessionRecord } from './sessions.js';
import type { DevelopmentScopeView, DevelopmentEvidence } from './development.js';
import type { DefinitionSnapshot } from './definitions.js';
import type { ToolWorktreeIdentity } from './tool-runtime.js';
import type { ProviderId } from './provider-contract.js';
import type { LocalTaskPreparation } from './local-tasks.js';
import type { InteractionView } from './interactions.js';
import type { RequestPhase, GatePolicy } from './request-gates.js';

/** Public snapshots deliberately exclude provider credentials and approved file contents. */
export interface WorkerBoardSettings {
  paused: boolean; maxParallel: number; queueCapacity: number; orchestratorQueue: number; order: 'fifo' | 'priority';
}
export interface WorkerSettingsView {
  defaultProvider: ProviderId;
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
  featureTracking?: Pick<FeatureTrackingStatus, 'directory' | 'lastSyncedAt' | 'error'>;
  capacity?: WorkerCapacitySnapshot;
  selected: string;
  execution: { currentSessionId: string | null; queued: number; maxParallel: number };
  records: Array<SessionRecord & { featureRequest?: FeatureTrackingRecord; requestId?: string; requestPhase?: RequestPhase; requestRevision?: number; status: string; interaction: InteractionView; busy: boolean; messages: number }>;
}
/** Shared public task fields are an allowlist, independent of the private execution aggregate. */
export interface LocalTaskView {
  selection?: ModelSelection;
  effort?: ModelEffort;
  feature?: FeatureRequestReference;
  id: string;
  title: string;
  sessionId: string;
  provider: ProviderId;
  model: string;
  repository: string;
  status: LocalTaskStatus;
  priority: number;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  summary: string | null;
  archived: boolean;
  requestId?: string;
  changedFileCount?: number;
  runId?: string;
  currentTurnId?: string;
  submissionHash?: string;
  submissionContextHash?: string;
  gatePolicy?: GatePolicy;
  criteria?: string[];
  definition?: DefinitionSnapshot;
  repositoryId?: string;
  worktree?: string;
  worktreeKey?: string;
  admissionFailure?: { paths: string[] };
  worktreeIdentity?: ToolWorktreeIdentity;
  baseCommit?: string;
  implementation?: DevelopmentScopeView;
  developmentEvidence?: DevelopmentEvidence;
}
export type LocalTaskStatus = 'queued' | 'running' | 'review' | 'failed' | 'cancelled' | 'waiting_input' | 'escalated' | 'needs_rework';
/** Polling summaries contain hashes instead of accepted file contents or patch bodies. */
export interface LocalTaskSummaryView extends LocalTaskView {
  files: Array<{ path: string; sha256: string }>;
  hasPatch: boolean;
  interaction: InteractionView;
  requestPhase?: RequestPhase;
  requestRevision?: number;
}
/** Authenticated inspection deliberately includes approved inputs and reviewable output. */
export interface LocalTaskDetailView extends LocalTaskView {
  instruction: string;
  files: Array<{ path: string; content: string; existed: boolean }>;
  patch: string | null;
  interaction: InteractionView;
}
export interface LocalTaskboardView {
  settings: WorkerBoardSettings;
  tasks: LocalTaskSummaryView[];
  /** Background admissions (`background: true`) until their task appears, or failed with a reason. Absent from older workers. */
  preparations?: LocalTaskPreparation[];
  persistenceError: boolean;
  running: number;
}
