import { DomainError } from '../../shared/errors.js';
import { identifier } from '../../shared/contracts.js';
import { featureWorkflowConfigPath, featureWorkflowSources } from '../application/feature-workflow.js';
import { gateDigest } from '../application/request-gates.js';
import type { FeatureTemplateView } from '../application/feature-authoring-contracts.js';
import { parseFeature } from '../infrastructure/features/document.js';
import { featureTemplateContent, loadFeatureWorkflowSnapshot } from '../infrastructure/features/workflow.js';
import { repositoryGit } from '../infrastructure/repositories-git.js';
import { assertNativeWorkReady } from './workspace-native-work.js';
import type { WorkspaceContext } from './workspace-context.js';

/** Read exact committed template bytes. HTTP callers cannot supply alternate template content or paths. */
export async function projectFeatureTemplate(workspace: WorkspaceContext, projectId?: string, templateId?: string) {
  assertNativeWorkReady(workspace);
  const project = workspace.featureProjects.resolve(projectId === undefined ? undefined : identifier(projectId, 'Project ID'));
  const repository = workspace.featureProjects.repository(project), binding = project.sharedRuntime.intake.binding;
  const signal = AbortSignal.any([workspace.repositoryStop.signal, AbortSignal.timeout(30000)]);
  const commit = binding?.repositoryId ? await project.sharedRuntime.selectedBaseline(signal) : (await repositoryGit(repository, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)).trim();
  const configPath = binding?.repositoryId ? binding.workflowPath : featureWorkflowConfigPath;
  const readBlob = async (_commit: string, path: string): Promise<string | null> => {
    const listing = await repositoryGit(repository, ['ls-tree', '-z', commit, '--', path], signal, 30000, 65536);
    if (!listing) return null;
    if (!/^100(?:644|755) blob /.test(listing) || listing.split('\0').filter(Boolean).length !== 1) throw new DomainError('conflict', 'Template workflow files must be regular committed files.');
    return repositoryGit(repository, ['show', commit + ':' + path], signal, 30000, 65536);
  };
  if (await readBlob(commit, configPath) === null) throw new DomainError('not_found', 'This project has no committed Feature Request workflow.');
  const snapshot = await loadFeatureWorkflowSnapshot({ commit, configPath, readBlob });
  const template = featureTemplateContent(snapshot, templateId), selected = parseFeature(template).data.templateId;
  if (typeof selected !== 'string') throw new DomainError('conflict', 'The selected project template has no stable identity.');
  return { snapshot, template, templateId: selected };
}
export async function featureTemplateView(workspace: WorkspaceContext, projectId?: string): Promise<FeatureTemplateView> {
  const project = workspace.featureProjects.resolve(projectId === undefined ? undefined : identifier(projectId, 'Project ID'));
  const id = workspace.featureProjects.id(project);
  try {
    const { snapshot, templateId } = await projectFeatureTemplate(workspace, projectId);
    const templates = snapshot.templates?.map(({ id, label, path, default: defaultTemplate }) => ({ id, label, path, default: defaultTemplate }))
      ?? [{ id: templateId, label: 'Default Feature Request', path: snapshot.configuration.template, default: true }];
    return { projectId: id, configured: true, defaultTemplateId: templateId, templates, workflowDigest: gateDigest(featureWorkflowSources(snapshot)) };
  } catch (error) {
    return { projectId: id, configured: false, defaultTemplateId: null, templates: [],
      reason: error instanceof DomainError ? error.message : 'The committed project template workflow could not be read.' };
  }
}
