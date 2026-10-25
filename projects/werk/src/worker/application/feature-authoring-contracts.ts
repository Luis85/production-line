import type { ModelEffort } from './model-effort.js';
import type { FeatureWorkflowSnapshot } from './feature-workflow.js';
import type { SharedIntakeConfig } from './shared-intake-contract.js';
import type { SharedRepositoryPort } from './shared-feature-state.js';

export type FeatureAuthoringBinding = Pick<SharedIntakeConfig, 'repositoryId' | 'remote' | 'branch' | 'workflowPath'>;
export interface FeatureAuthoringSeed {
  title: string; message: string; templateId?: string; priority?: number; provider?: string; model?: string; effort?: ModelEffort; executionProfile?: string; paths?: string[];
  definitionRef?: string; agent?: string; useInstructionsOnly?: boolean;
}
export interface FeatureAuthoringCommand {
  projectId?: string;
  action: 'prepare' | 'publish'; operationId: string; name?: string; markdown?: string; status?: 'draft' | 'ready';
  seed?: FeatureAuthoringSeed; expectedRevision?: string | null;
  expectedWorkflowDigest?: string; expectedBinding?: FeatureAuthoringBinding;
}
export interface FeatureAuthoringReadiness { reviewRequired?: boolean; valid: boolean; errors: { code: string; message: string }[]; }
export interface FeatureTemplateChoice { id: string; label: string; path: string; default: boolean; }
export interface FeatureTemplateView {
  projectId: string; configured: boolean; defaultTemplateId: string | null;
  templates: FeatureTemplateChoice[]; workflowDigest?: string; reason?: string;
}
export interface FeatureAuthoringResult {
  templateId?: string; templates?: FeatureTemplateChoice[];
  featureId: string; name: string; path: string; markdown: string; revision: string | null;
  status: 'draft' | 'ready'; readiness: FeatureAuthoringReadiness;
  workflowDigest: string; binding: FeatureAuthoringBinding;
  publication?: { commit: string; head: string; replayed?: boolean };
}
export interface FeatureRequestPublication {
  operationId: string;
  request: { path: string; expectedRevision: string | null; content: string };
  workflowFiles: { path: string; sha256: string }[];
  workflowDigest: string; binding: FeatureAuthoringBinding; readinessError?: string;
}
export interface FeatureAuthoringRepository extends Pick<SharedRepositoryPort, 'head' | 'readBlob' | 'listRequests'> {
  publishRequest(input: FeatureRequestPublication, signal: AbortSignal): Promise<{ commit: string; head: string; replayed?: boolean }>;
}
export interface FeatureAuthoringDocuments {
  prepare(snapshot: FeatureWorkflowSnapshot, featureId: string, seed?: FeatureAuthoringSeed): string;
  status(markdown: string, status: 'draft' | 'ready'): string;
  inspect(markdown: string): { id: string; status: 'draft' | 'ready'; templateId?: string };
  ready(markdown: string, snapshot: FeatureWorkflowSnapshot, provider?: string): FeatureAuthoringReadiness;
}
export interface FeatureAuthoringPorts {
  binding(): FeatureAuthoringBinding | null;
  repository(binding: FeatureAuthoringBinding, snapshot?: FeatureWorkflowSnapshot): FeatureAuthoringRepository;
  loadWorkflow(repository: FeatureAuthoringRepository, commit: string, path: string, signal: AbortSignal): Promise<FeatureWorkflowSnapshot>;
  documents: FeatureAuthoringDocuments;
  sync(): Promise<unknown>;
}
