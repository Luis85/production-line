import { managedProjectLocations } from '../infrastructure/managed-project-locations.js';
import { managedProjectGit } from '../infrastructure/managed-project-git.js';
import { GitFeatureError } from '../infrastructure/features/git-io.js';
import { identifier } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import { ManagedProjectSetup } from '../application/managed-project-setup.js';
import { managedProjectSetupGit } from '../infrastructure/managed-project-setup.js';
import { managedProjectSetupStorage } from '../infrastructure/managed-project-setup-storage.js';
import { managedProjectStorage } from '../infrastructure/managed-project-storage.js';
import type { WorkspaceContext } from './workspace-context.js';

/** Composition adds machine admission; setup never creates approval or starts intake. */
export async function managedSetupCommand(workspace: WorkspaceContext, input: unknown, signal: AbortSignal) {
  const id = identifier((input as { id?: unknown })?.id, 'Project ID');
  const storage = managedProjectStorage(workspace.config.stateDir), state = await storage.load();
  const project = state.projects.find(item => item.id === id);
  if (!project || project.status !== 'ready' || !project.attached) throw new DomainError('conflict', 'Register and confirm the managed project before previewing its workflow setup.');
  const locations = managedProjectLocations(workspace.config.stateDir, workspace.config.homeDir);
  const setup = new ManagedProjectSetup({ ...managedProjectSetupStorage(workspace.config.stateDir, id, locations.placement(project).privateDirectory), ...managedProjectSetupGit(workspace.config.stateDir, project, signal, locations) });
  const result = await setup.command(input, workspace.settings.value.defaultProvider).catch(error => {
    if (error instanceof GitFeatureError) throw new DomainError(error.code === 'cancelled' ? 'unavailable' : error.code, error.message);
    throw error;
  });
  if ('status' in result && result.status === 'published' && result.commit) {
    const observed = await managedProjectGit(workspace.config.stateDir, locations).inspect(project, signal);
    if (observed.ready && observed.head) project.head = observed.head;
    project.updatedAt = new Date().toISOString();
    project.detail = 'Workflow setup is committed on the shared branch. Approve its exact delivery policy, then recheck project setup.';
    await storage.save(state);
  }
  return result;
}
