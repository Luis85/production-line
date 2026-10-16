import type { FeatureWorkflowSnapshot, SharedFeatureInput } from './feature-workflow.js';
import type { WorkerRequest } from './request-gates.js';
import type { SharedFeatureView, SharedIntakeConfig } from './shared-intake-contract.js';
import { DomainError } from '../../shared/errors.js';

export const defaultSharedIntakeConfig = (): SharedIntakeConfig => ({ enabled: false, repositoryId: '', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 5000 });
export function validateSharedIntakeConfig(value: unknown): SharedIntakeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('invalid_input', 'Shared intake requires a configuration object.');
  const d = value as Record<string, unknown>;
  if (Object.keys(d).some(k => !['enabled', 'repositoryId', 'remote', 'branch', 'workflowPath', 'pollMs'].includes(k)) || typeof d.enabled !== 'boolean') throw new DomainError('invalid_input', 'Invalid shared intake configuration.');
  if (typeof d.repositoryId !== 'string' || !/^[a-zA-Z0-9_-]{0,100}$/.test(d.repositoryId) || (d.enabled && !d.repositoryId)) throw new DomainError('invalid_input', 'Choose an assigned repository.');
  if (typeof d.remote !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(d.remote)) throw new DomainError('invalid_input', 'Choose a configured Git remote name.');
  if (typeof d.branch !== 'string' || d.branch.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(d.branch) || d.branch.includes('..') || d.branch.includes('//') || d.branch.split('/').some(p => !p || p.startsWith('.') || p.endsWith('.') || p.endsWith('.lock'))) throw new DomainError('invalid_input', 'Use a valid Git intake branch name.');
  if (typeof d.workflowPath !== 'string' || d.workflowPath.length > 500 || !d.workflowPath.endsWith('.json') || /[\\\x00-\x1f\x7f:]/.test(d.workflowPath) || d.workflowPath.split('/').some(p => !p || p === '.' || p === '..' || p === '.git' || p === 'node_modules')) throw new DomainError('invalid_input', 'Use a repository-relative workflow JSON path.');
  if (!Number.isSafeInteger(d.pollMs) || Number(d.pollMs) < 1000 || Number(d.pollMs) > 300000) throw new DomainError('invalid_input', 'Shared intake interval must be 1,000–300,000 milliseconds.');
  return structuredClone(d) as unknown as SharedIntakeConfig;
}
export interface SharedBlob { name: string; path: string; revision: string; content: string; }
export interface LifecycleWrite {
  operationId: string;
  request: { path: string; expectedRevision: string; content: string };
  artifacts: { path: string; expectedRevision: string | null; content: string }[];
}
export interface SharedRepositoryPort {
  head(signal: AbortSignal): Promise<string>;
  readBlob(commit: string, path: string, signal: AbortSignal): Promise<string | null>;
  listRequests(commit: string, signal: AbortSignal): Promise<SharedBlob[]>;
  publishLifecycle(input: LifecycleWrite, signal: AbortSignal): Promise<{ commit: string; head: string }>;
  publishPatch(input: { operationId: string; featureId: string; sourceCommit: string; patch: string; approvedPaths: string[] }, signal: AbortSignal): Promise<{ commit: string; head: string; branch: string }>;
}
export interface SharedFeatureRecord extends SharedFeatureView {
  binding: SharedIntakeConfig;
  sourcePath: string;
  sourceMarkdown: string;
  remoteRevision: string;
  accepted: SharedFeatureInput;
  inputHash: string;
  workflow: FeatureWorkflowSnapshot;
  claimed: boolean;
  submitted: boolean;
  pending?: LifecycleWrite;
  publishedState?: string;
  featureCommit?: string;
  outputDigest?: string;
  reviewMarkdown?: string;
  publishedReview?: string;
}
export interface SharedFeatureState {
  schemaVersion: 1;
  workerId: string;
  revision: number;
  config: SharedIntakeConfig;
  records: SharedFeatureRecord[];
}
export interface SharedExecution {
  status: string;
  summary: string | null;
  patch: string | null;
  request: WorkerRequest | null;
  currentTurnId?: string;
  runId?: string;
  error?: string | null;
}
export interface SharedIntakePorts {
  load(): Promise<SharedFeatureState>;
  save(state: SharedFeatureState): Promise<void>;
  repository(binding: SharedIntakeConfig, workflow?: FeatureWorkflowSnapshot): SharedRepositoryPort;
  loadWorkflow(repository: SharedRepositoryPort, commit: string, path: string, signal: AbortSignal): Promise<FeatureWorkflowSnapshot>;
  ready(markdown: string, snapshot: FeatureWorkflowSnapshot): { valid: boolean; input?: SharedFeatureInput; inputHash?: string; errors: { code: string; message: string }[] };
  source(blob: SharedBlob): { id?: string; title: string; status: string; shared?: SharedFeatureView };
  renderSource(record: SharedFeatureRecord): string;
  submit(record: SharedFeatureRecord): Promise<void>;
  inspect(taskId: string): SharedExecution | undefined;
  canAdmit(): boolean;
}
export function bindingKey(config: SharedIntakeConfig) { return JSON.stringify([config.repositoryId, config.remote, config.branch, config.workflowPath]); }
export const sharedTerminal = (status: string) => ['ready_for_review', 'failed', 'cancelled'].includes(status);
