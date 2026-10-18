import type { ConversationStore } from './conversation.js';
import type { ProviderConnection, ProviderId } from './provider-contract.js';
import type { RepositoryConfiguration } from './repositories.js';
import type { ExecutionPolicy } from './execution-policy.js';
import type { ToolPolicy } from './tool-policy.js';
import type { ToolWorktreeIdentity } from './tool-runtime.js';
import type { TaskFile } from './local-tasks.js';

/** Read-only configuration needed by session and approved-file workflows. */
export interface WorkerSettingsPort {
  readonly value: {
    defaultProvider?: ProviderId;
    repositories: RepositoryConfiguration;
    execution: ExecutionPolicy;
    board: { paused: boolean; maxParallel: number; queueCapacity: number; orchestratorQueue: number; order: 'fifo' | 'priority' };
  };
  provider(id: string): ProviderConnection;
  toolPolicy(): ToolPolicy;
}
/** Serialized catalog limits and schema validation belong to the corresponding application. */
export interface DefinitionStorage { read(): Promise<string | undefined>; write(serialized: string): Promise<void>; }
export interface SessionCatalogStorage {
  read(): Promise<string | undefined>;
  write(serialized: string): Promise<void>;
  conversation(sessionId: string): Promise<ConversationStore>;
}
export interface LocalTaskStorage {
  read(): Promise<string | undefined>;
  write(serialized: string): Promise<void>;
  writePatch(taskId: string, patch: string): Promise<void>;
}
export interface ApprovedTaskFiles {
  identity(path: string): Promise<ToolWorktreeIdentity>;
  snapshot(prepared: { repository: string; path: string; baseCommit?: string }, paths: readonly string[]): Promise<{ repository: string; path: string; files: TaskFile[] }>;
}
