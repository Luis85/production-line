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
export interface SharedFeatureView {
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
  };
  requests: SharedFeatureView[];
}
export interface SharedIntakeNote { path: string; markdown: string; }
export interface SharedIntakeUpdate { action: 'configure'; expectedRevision: number; config: SharedIntakeConfig; }
