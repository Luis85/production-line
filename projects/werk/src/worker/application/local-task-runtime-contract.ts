import type { ProcessObservation } from './process-observation.js';
import type { SerializedOperations } from '../../shared/serialized-operations.js';
import type { DevelopmentFactory, DevelopmentRuntime } from './development.js';
import type { LocalTaskboardView, LocalTaskDetailView } from './workspace-view.js';
import type { ModelFactory, ProviderConnection } from './provider-contract.js';
import type { WorkerSettingsPort, LocalTaskStorage, ApprovedTaskFiles } from './workspace-ports.js';
import type { GateInput, GateFactSnapshot, WorkerRequest } from './request-gates.js';
import type { ModelRequest } from './model-contract.js';
import type { InteractionCommand, InteractionTurn, InteractionView } from './interactions.js';
import type { DefinitionSnapshot } from './definitions.js';
import type { WorkerSessions } from './sessions.js';
import type { ConversationModel } from './conversation.js';
import type { ValidatedPatch } from './patch-protocol.js';
import type { RepositoryAssignment } from './repositories.js';
import type { LocalTask, LocalTaskPreparation, LocalTaskSubmission, LocalTaskWorkspaces } from './local-task-contracts.js';

export interface LocalTaskDependencies {
  model: ModelFactory;
  storage: LocalTaskStorage;
  files: ApprovedTaskFiles;
  workspaces?: LocalTaskWorkspaces;
  development?: DevelopmentFactory;
  observations?: ProcessObservation;
}
export interface LocalTaskState {
  tasks: LocalTask[];
  writing: SerializedOperations;
  admitting: SerializedOperations;
  admissionReserved: boolean;
  admissionTaskId?: string;
  preparations: LocalTaskPreparation[];
  preparationOwners: Map<string, { submission?: LocalTaskSubmission; definition: DefinitionSnapshot | null; controller: AbortController }>;
  continuationReservations: number;
  continuations: Set<Promise<unknown>>;
  workspaceController: AbortController;
  running: Map<string, { controller: AbortController; promise: Promise<void> }>;
  closed: boolean;
  persistenceError: boolean;
  evidencePersistenceError: boolean;
}
export interface AdmissionInput {
  body: Record<string, unknown>;
  title: string;
  instruction: string;
  definition: DefinitionSnapshot | undefined;
  provider: ProviderConnection;
  selector: string;
  assignment: RepositoryAssignment | undefined;
  repositoryPath: string;
  allowedPaths: string[];
}
export interface AdmissionOptions {
  id?: string;
  budgetMs?: number;
  preparation?: LocalTaskPreparation;
  signal?: AbortSignal;
  definition?: DefinitionSnapshot | null;
}
export type WorktreeRemoval = { outcome: 'removed' | 'kept' | 'not_applicable'; reason?: string };
export type TaskActionView = LocalTaskboardView & { worktree?: WorktreeRemoval };

/** One owner holds admission and persistence state; helpers receive only the fields they consume. */
export interface LocalTaskRuntime extends LocalTaskDependencies, LocalTaskState {
  settings: WorkerSettingsPort;
  sessions: WorkerSessions;
  init(): Promise<void>;
  reserveRun(task: LocalTask): Promise<string>;
  gateInput(task: LocalTask): GateInput;
  ensureRequest(task: LocalTask): WorkerRequest;
  outputFacts(valid: { patch: string; changedFileCount: number } | null, task?: LocalTask): GateFactSnapshot;
  context(task: LocalTask): Record<string, unknown>;
  originalPrompt(task: LocalTask): string;
  preparedRequest(task: LocalTask, turn: InteractionTurn, model: ConversationModel): ModelRequest;
  developmentRuntime(task: LocalTask, commandTimeoutMs?: number): DevelopmentRuntime | undefined;
  restoredDevelopment(task: LocalTask, turn: InteractionTurn): ValidatedPatch | null;
  assertToolWorkspace(task: LocalTask, signal: AbortSignal, verifyOnly?: boolean): Promise<void>;
  assertAcceptedSnapshots(task: LocalTask): void;
  prepareTurn(task: LocalTask, turn: InteractionTurn, admission?: AbortSignal): Promise<void>;
  validatedPatch(task: LocalTask, reply: string): ValidatedPatch;
  completionMessage(task: LocalTask, summary: string, reply: string): string;
  writePatch(task: LocalTask, patch: string): Promise<void>;
  recoverTask(task: LocalTask): Promise<void>;
  input(task: LocalTask): string;
  readonly active: number;
  readonly admissionOccupancy: number;
  preparation(id: string): LocalTaskPreparation | undefined;
  preparationDefinition(id: string): DefinitionSnapshot | undefined;
  view(): LocalTaskboardView;
  readonly waitingPreparations: number;
  detail(id: string): LocalTaskDetailView;
  executionDetail(id: string): LocalTask & { interaction: InteractionView };
  persist(tasks: LocalTask[]): Promise<void>;
  change(operation: (tasks: LocalTask[]) => void | Promise<void>): Promise<void>;
  create(input: unknown, submission?: LocalTaskSubmission): Promise<LocalTaskboardView>;
  forgetPreparation(preparation: LocalTaskPreparation): void;
  createInBackground(input: unknown, submission?: LocalTaskSubmission): LocalTaskboardView & { preparationId: string };
  assertAdmissionCapacity(tasks: LocalTask[], reserved?: number): void;
  admissionInput(input: unknown, submission?: LocalTaskSubmission, frozenDefinition?: DefinitionSnapshot | null): AdmissionInput;
  createTask(input: unknown, submission?: LocalTaskSubmission, options?: AdmissionOptions): Promise<LocalTaskboardView>;
  trackContinuation<T>(operation: Promise<T>): Promise<T>;
  executeRequest(id: string): Promise<LocalTaskboardView>;
  executeOwnedRequest(id: string): Promise<LocalTaskboardView>;
  interact(body: InteractionCommand): Promise<InteractionView>;
  continueTask(body: InteractionCommand): Promise<InteractionView>;
  action(input: unknown, expectedInteractionRevision?: number): Promise<TaskActionView>;
  removeTaskWorktree(task: LocalTask, requested: boolean | undefined, discardChanges: boolean): Promise<WorktreeRemoval>;
  tick(): Promise<void>;
  execute(id: string, controller: AbortController): Promise<void>;
  close(): Promise<void>;
}
