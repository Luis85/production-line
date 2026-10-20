import type { FeatureRequests } from '../application/feature-requests.js';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { object, text, identifier } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import { validateApprovedPaths } from '../application/approved-paths.js';
import { featureInput, parseFeature } from '../infrastructure/features/document.js';
import { taskDetail } from './workspace-task-views.js';
import type { WorkspaceContext } from './workspace-context.js';

function selectedProject(workspace: WorkspaceContext, input: unknown) {
  const body = input as { projectId?: unknown; files?: { repository?: unknown } };
  if (body?.projectId !== undefined) return workspace.featureProjects.resolve(identifier(body.projectId, 'projectId'));
  if (typeof body?.files?.repository === 'string') return workspace.featureProjects.forRepository(body.files.repository) ?? workspace.featureProjects.primary;
  return workspace.featureProjects.primary;
}
export function usesLocalFeatureIntake(workspace: WorkspaceContext, input: unknown) {
  if (!input || typeof input !== 'object' || (input as { action?: unknown }).action !== 'create') return false;
  const project = selectedProject(workspace, input);
  if (!project.features || project.sharedRuntime.intake.binding?.repositoryId) return false;
  if (!project.primary) return true;
  const id = (input as { id?: unknown }).id;
  const existing = workspace.sessions.view().records.find(record => record.id === id || record.id === 'local-' + id);
  return !existing || existing.feature?.source === 'folder';
}
/** Runs before taskRequests serialization, so the canonical watcher can use the existing task port. */
export async function createLocalFeatureInteraction(workspace: WorkspaceContext, input: unknown) {
  if (!workspace.acceptingTasks || workspace.configurationUpdating || workspace.executionProfiles?.pending()) throw new DomainError('unavailable', 'Finish the configuration change before creating a Feature Request.');
  const body = object(input, 'Task command', ['action', 'id', 'title', 'provider', 'model', 'effort', 'message', 'definitionId', 'definitionRef', 'agent', 'useInstructionsOnly', 'files', 'background', 'projectId', 'executionProfile']);
  const id = body.id === undefined ? randomUUID() : identifier(body.id, 'id');
  if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new DomainError('invalid_input', 'Local interaction IDs use 1–80 lowercase letters, digits or hyphens.');
  if (body.background !== undefined && (typeof body.background !== 'boolean' || body.background && !body.files)) throw new DomainError('invalid_input', 'background requires approved files.');
  const files = body.files === undefined ? undefined : object(body.files, 'Approved files', ['repository', 'paths']);
  const intake = selectedProject(workspace, input), project = intake.repository;
  if (files && resolve(text(files.repository, 'repository', 4096)) !== project) throw new DomainError('invalid_input', 'This intake folder belongs to another project. Select this worker’s project repository or use the worker assigned to the requested project.');
  const paths = files ? validateApprovedPaths(files.paths, 'Approved paths', { folders: true }) : undefined;
  const provider = workspace.settings.provider(String(body.provider ?? workspace.settings.value.defaultProvider)).id;
  const fields = { schema: 'worker.request/v1', id, title: text(body.title, 'title', 120), intent: 'submit', mode: paths ? 'patch' : 'chat', ...(body.provider === undefined ? {} : { provider }),
    priority: 'normal', ...(body.executionProfile === undefined ? {} : { execution_profile: body.executionProfile }), ...(paths ? { paths } : {}),
    ...Object.fromEntries(['model', 'effort', 'definitionId', 'definitionRef', 'agent', 'useInstructionsOnly'].filter(key => body[key] !== undefined).map(key => [key, body[key]])),
  };
  const markdown = '---\n' + stringify(fields) + '---\n' + text(body.message, 'message', 8000) + '\n';
  const normalized = featureInput(parseFeature(markdown), provider);
  workspace.definitions.select(body);
  const features: FeatureRequests = intake.features!;
  const receipt = await features.publishInteraction(id, normalized, markdown);
  await features.tick(true); await features.tick(true);
  const preparation = workspace.board.preparation(receipt.taskId);
  if (preparation) return { preparation };
  if (!workspace.sessions.view().records.some(record => record.id === receipt.sessionId)) {
    const record = features.view().records.find(record => record.id === id);
    const reason = record?.sourceIssue?.reason ?? record?.error ?? features.view().errors.find(error => error.file === receipt.name)?.message ?? 'The worker is waiting for admission.';
    throw new DomainError('conflict', `Feature Request saved as ${receipt.name}. ${reason} Retry the same interaction ID after resolving this; its note remains the source of truth.`);
  }
  const { directory, lastSyncedAt, error } = workspace.featureTracking.status();
  return { ...taskDetail(workspace, receipt.sessionId), featureTracking: { directory, lastSyncedAt, error } };
}
