import type { ModelSelection } from './model-selection.js';
import type { FeatureRequestReference } from './feature-request-reference.js';
/** Public worker UI contract. Git credentials and private runtime state are never returned. */
export interface SharedIntakeConfig {
  enabled: boolean;
  repositoryId: string;
  remote: string;
  branch: string;
  workflowPath: string;
  pollMs: number;
}
/** Public readiness review evidence excludes private prompt bytes and model checkpoints. */
export interface SharedFeatureReadyReviewView {
  status: 'queued' | 'running' | 'waiting_input' | 'passed' | 'failed';
  attempt: number;
  sessionId?: string;
  runId?: string;
  promptPath: string;
  promptDigest: string;
  findings: { kind: 'question' | 'issue' | 'gap'; message: string; blocking: boolean }[];
}
export interface SharedFeatureView {
  selection?: ModelSelection;
  readyReview?: SharedFeatureReadyReviewView;
  feature?: FeatureRequestReference;
  id: string;
  name: string;
  title: string;
  status: string;
  owner: string | null;
  isLocal: boolean;
  sourceCommit: string;
  updatedAt: string;
  ready: { passed: boolean; issues: string[] } | null;
  done: { passed: boolean; issues: string[] } | null;
  featureBranch: string | null;
  reviewNote: string | null;
  taskNote?: string | null;
  /** Projection of the existing Task response; never includes its answer or private journal. */
  taskResponse?: {
    sessionId: string;
    expectedRevision: number;
    pendingId: string | null;
    turnId: string;
    status: 'publication_pending' | 'ready' | 'processed' | 'error';
    error: string | null;
  };
  publication: 'pending' | 'synced' | 'error';
  error: string | null;
  taskId: string | null;
}
export interface SharedIntakeView {
  revision: number;
  workerId: string;
  config: SharedIntakeConfig;
  canEdit: boolean;
  blockedReason: string | null;
  state: 'disabled' | 'idle' | 'syncing' | 'error';
  error: string | null;
  lastSyncedAt: string | null;
  sourceCommit: string | null;
  workflow: null | {
    requestsDirectory: string;
    reviewDirectory: string;
    tasksDirectory?: string;
    template: string;
    base: string;
    readyCheck: string;
    doneCheck: string;
    readyDigest: string;
    doneDigest: string;
    readyReviewPrompt?: string;
    readyReviewPromptDigest?: string;
    readyPrompt?: string;
    donePrompt?: string;
    readyPromptDigest?: string;
    donePromptDigest?: string;
  };
  requests: SharedFeatureView[];
}
export interface SharedIntakeNote { path: string; markdown: string; }
export interface SharedIntakeUpdate { action: 'configure'; expectedRevision: number; config: SharedIntakeConfig; }
