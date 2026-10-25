import { dispatchSharedReviewRework } from './workspace-review-rework.js';
import { assertNativeWorkReady } from './workspace-native-work.js';
import { resolve } from 'node:path';
import { DomainError } from '../../shared/errors.js';
import { FeatureRequests, type FeatureInput } from '../application/feature-requests.js';
import { prepareFeatureExecution } from './workspace-feature-execution.js';
import { modelSelection } from '../application/model-selection.js';
import { definitionConnection } from '../application/definitions.js';
import { MarkdownFeatureFolder } from '../infrastructure/features/folder.js';
import { SharedIntakeRuntime } from '../infrastructure/features/shared-intake-runtime.js';
import { sharedFeatureAdmissionHold } from './workspace-feature-admission.js';
import { submitSharedFeature, submitFeature, inspectSharedFeature, inspectFeature, continueFeatureInteraction, reprioritizeFeature } from './workspace-features.js';
import { featureSourceHold, reviseFeatureSource, sharedFeatureSourceHold } from './workspace-delivery.js';
import { requestCommand } from './workspace-requests.js';
import { taskboardAction } from './workspace-task-views.js';
import { task } from './workspace-tasks.js';
import type { WorkspaceContext } from './workspace-context.js';

export interface WorkspaceFeatureProject {
  id?: string; repository: string; stateDirectory: string; primary: boolean;
  directory?: string; pollMs: number; features?: FeatureRequests; sharedRuntime: SharedIntakeRuntime;
}
function definitionIssue(workspace: WorkspaceContext, input: FeatureInput) {
  if (input.executionProfile) return undefined;
  try { definitionConnection(workspace.settings.provider(input.provider), workspace.definitions.select({ ...input })); return undefined; }
  catch (error) { return error instanceof Error ? error.message : 'The selected agent definition is unavailable.'; }
}
/** Each project composes the same intake engines; sessions, execution and request ownership remain worker-wide. */
export function createProjectFeatureRuntime(workspace: WorkspaceContext, config: Omit<WorkspaceFeatureProject, 'features' | 'sharedRuntime'>): WorkspaceFeatureProject {
  const sharedRuntime = new SharedIntakeRuntime({
    stateDirectory: config.stateDirectory,
    resolve: id => {
      if (config.id && id !== config.id) throw new DomainError('conflict', 'Shared intake must use the selected project repository.');
      return workspace.repositories.resolve(id);
    },
    allowed: path => { assertNativeWorkReady(workspace); return workspace.repositoryDiscovery.assertAllowed(path); },
    canAdmit: () => !sharedFeatureAdmissionHold(workspace),
    admissionHold: () => sharedFeatureAdmissionHold(workspace),
    submit: record => submitSharedFeature(workspace, record),
    reviewRework: (record, command) => dispatchSharedReviewRework(workspace, record, command),
    sourceHold: (record, reason) => sharedFeatureSourceHold(workspace, record, reason),
    readyReview: workspace.readyReviews,
    defaultProvider: () => workspace.settings.value.defaultProvider,
    prepare: (input, binding, baseline) => prepareFeatureExecution(workspace, input, workspace.repositories.resolve(binding.repositoryId).path, binding.repositoryId, baseline),
    resolveSelection: input => modelSelection(workspace.settings.provider(input.provider), input, workspace.definitions.select({ ...input })),
    continue: (record, command) => continueFeatureInteraction(workspace, workspace.board.executionDetail(record.taskId!).sessionId, command),
    admissionIssue: input => definitionIssue(workspace, input),
    inspect: id => inspectSharedFeature(workspace, id),
  });
  const project: WorkspaceFeatureProject = { ...config, repository: resolve(config.repository), sharedRuntime };
  attachProjectFeatureFolder(workspace, project);
  return project;
}
export function attachProjectFeatureFolder(workspace: WorkspaceContext, project: WorkspaceFeatureProject) {
  if (project.directory) project.features = new FeatureRequests(
    new MarkdownFeatureFolder(project.directory, project.stateDirectory, () => workspace.settings.value.defaultProvider, project.repository, project.id),
    {
      projectId: () => workspace.featureProjects.id(project),
      prepare: input => prepareFeatureExecution(workspace, input, project.repository, workspace.featureProjects.id(project)),
      selection: input => modelSelection(workspace.settings.provider(input.provider), input, workspace.definitions.select({ ...input })),
      submit: record => submitFeature(workspace, record, project),
      reprioritize: (record, priority) => reprioritizeFeature(workspace, record, priority),
      source: (record, issue) => featureSourceHold(workspace, record, issue),
      revise: (record, input) => reviseFeatureSource(workspace, record, input),
      request: (_record, command) => requestCommand(workspace, command, { canonicalSource: true }),
      admissionIssue: input => definitionIssue(workspace, input),
      inspect: record => inspectFeature(workspace, record),
      reference: id => workspace.sessions.view().records.find(record => record.id === id)?.feature,
      interact: (record, command) => continueFeatureInteraction(workspace, record.sessionId, command),
      control: (record, action) => record.input?.mode === 'patch'
        ? taskboardAction(workspace, { id: record.taskId, action }) : task(workspace, { id: record.sessionId, action }),
    }, project.pollMs, () => workspace.nativeWorkState === 'ready' && !project.sharedRuntime.intake.binding?.repositoryId, project.id,
  );
  return project.features;
}
