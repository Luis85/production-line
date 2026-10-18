import type { CandidateInspectionLimits } from './execution-policy.js';
import type { ProjectModelContext } from './model-context.js';
import { validateFeatureRequestReference, type FeatureRequestReference } from './feature-request-reference.js';

import { type DevelopmentCompletion, type DevelopmentScope, type DevelopmentEvidence } from './development.js';
import type { LocalTaskStatus } from './workspace-view.js';

import type { ToolWorktreeIdentity } from './tool-runtime.js';
import type { ProviderId } from './provider-contract.js';

import { gateDigest, validateGateInput, validateGatePolicy, type GatePolicy } from "./request-gates.js";

import { type DefinitionSnapshot } from "./definitions.js";
import { createHash } from "node:crypto";

import { object } from "../../shared/contracts.js";
import { DomainError } from "../../shared/errors.js";

/** Repository adapters prepare committed worktrees; plain folders remain a legacy fallback. */
export interface LocalTaskWorkspaces {
  prepareWorktree(
    selector: string,
    taskKey: string,
    signal: AbortSignal,
    baseCommit?: string,
    inspection?: Partial<CandidateInspectionLimits>,
  ): Promise<{
    repositoryId?: string;
    repository: string;
    path: string;
    baseCommit?: string;
    reused?: boolean;
    /** True only when an owned checkout still matches its pinned committed inputs. */
    pristine?: boolean;
  }>;
  /** Re-verify a retained worktree without fetching or creating it; adapters without it use prepareWorktree. */
  verifyWorktree?: LocalTaskWorkspaces["prepareWorktree"];
  /** Remove an owned, clean task worktree after the identity pin was checked. */
  removeWorktree?(
    selector: string,
    taskKey: string,
    signal: AbortSignal,
    expected: { path: string; baseCommit: string; discardChanges: boolean },
  ): Promise<{ outcome: "removed" | "would_remove" | "kept"; reason?: string }>;
}
/** One budget covers queueing, fetch, checkout and verification of a new task worktree. */
export const ADMISSION_TIMEOUT_MS = 120000;
/** Background admission does not hold an HTTP request open, so large checkouts get more time. */
export const BACKGROUND_ADMISSION_TIMEOUT_MS = 600000;
/** In-memory admission accepted with `background: true`; never persisted across restarts. */
export interface LocalTaskPreparation {
  id: string;
  title: string;
  repository: string;
  state: "preparing" | "failed";
  phase: "waiting" | "worktree" | "admission";
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}
/** Trusted coordinator reservation; these fields are never accepted from a task HTTP body. */
export interface LocalTaskSubmission {
  feature?: FeatureRequestReference;
  id: string;
  hash: string;
  policy?: GatePolicy;
  criteria?: string[];
  repositoryId?: string;
  baseCommit?: string;
}
export function freezeSubmission(input: LocalTaskSubmission): LocalTaskSubmission {
  const value = object(input, "Task reservation", ["id", "hash", "policy", "criteria", "repositoryId", "baseCommit", "feature"]);
  if (typeof value.id !== "string" || !/^[a-z0-9-]{1,90}$/.test(value.id) ||
      typeof value.hash !== "string" || !/^[a-f0-9]{64}$/.test(value.hash))
    throw new DomainError("invalid_input", "Invalid feature task identity.");
  if (value.repositoryId !== undefined && (typeof value.repositoryId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value.repositoryId)))
    throw new DomainError("invalid_input", "Invalid reserved repository ID.");
  if (value.baseCommit !== undefined && (typeof value.baseCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.baseCommit)))
    throw new DomainError("invalid_input", "Task base must be a full Git commit identifier.");
  return {
    id: value.id,
    hash: value.hash,
    ...(value.feature === undefined ? {} : { feature: validateFeatureRequestReference(value.feature) }),
    ...(value.policy === undefined ? {} : { policy: validateGatePolicy(value.policy) }),
    ...(value.criteria === undefined ? {} : { criteria: validateGateInput({ kind: "patch", title: "", message: "", criteria: value.criteria }).criteria }),
    ...(value.repositoryId === undefined ? {} : { repositoryId: value.repositoryId as string }),
    ...(value.baseCommit === undefined ? {} : { baseCommit: value.baseCommit as string }),
  };
}
export function submissionContextHash(submission?: LocalTaskSubmission) {
  const context = { policy: submission?.policy, criteria: submission?.criteria, repositoryId: submission?.repositoryId, baseCommit: submission?.baseCommit };
  return Object.values(context).some(value => value !== undefined) ? gateDigest(context) : undefined;
}
export interface TaskFile {
  path: string;
  content: string;
  existed: boolean;
}
export interface LocalTask {
  projectContext?: ProjectModelContext | null;
  feature?: FeatureRequestReference;
  implementation?: DevelopmentScope;
  developmentEvidence?: DevelopmentEvidence;
  /** Completed candidate is persisted before the immutable interaction result. */
  developmentCompletion?: DevelopmentCompletion;
  requestId?: string;
  changedFileCount?: number;
  runId?: string;
  currentTurnId?: string;
  submissionHash?: string;
  submissionContextHash?: string;
  gatePolicy?: GatePolicy;
  criteria?: string[];
  definition?: DefinitionSnapshot;
  id: string;
  title: string;
  instruction: string;
  sessionId: string;
  provider: ProviderId;
  model: string;
  repository: string;
  repositoryId?: string;
  worktree?: string;
  worktreeKey?: string;
  /** No approved snapshots exist: retain the failed request without allowing execution. */
  admissionFailure?: { paths: string[] };
  worktreeIdentity?: ToolWorktreeIdentity;
  baseCommit?: string;
  files: TaskFile[];
  status: LocalTaskStatus;
  priority: number;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  summary: string | null;
  patch: string | null;
  archived: boolean;
}
export const fingerprint = (value: string) =>
  createHash("sha256").update(value).digest("hex");
