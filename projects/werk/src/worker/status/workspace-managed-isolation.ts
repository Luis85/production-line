import { resolve } from 'node:path';
import { DomainError } from '../../shared/errors.js';
import { ManagedProjects } from '../application/managed-projects.js';
import { managedProjectStorage } from '../infrastructure/managed-project-storage.js';
import { managedProjectLocations } from '../infrastructure/managed-project-locations.js';
import { managedProjectGit } from '../infrastructure/managed-project-git.js';
import type { WorkspaceContext } from './workspace-context.js';

/** Home authority cannot be granted by a repository settings assignment or an external checkout path. */
export async function assertManagedProjectIsolation(workspace: WorkspaceContext, repositoryId: string | undefined, repository?: string, options: { allowPendingAttachment?: boolean } = {}) {
  if (!workspace.config.homeDir) return;
  const git = managedProjectGit(workspace.config.stateDir, managedProjectLocations(workspace.config.stateDir, workspace.config.homeDir));
  const manager = new ManagedProjects({ ...managedProjectStorage(workspace.config.stateDir), ...git, async attach() {} });
  const project = await manager.assertIsolated(repositoryId ?? '', AbortSignal.any([workspace.repositoryStop.signal, AbortSignal.timeout(30000)]), options);
  if (repository && resolve(repository) !== resolve(project.path)) throw new DomainError('conflict', 'The repository assignment differs from its verified worker-owned checkout. Reconcile project setup before executing work.');
}
