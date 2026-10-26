import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DomainError } from '../../shared/errors.js';
import type { ManagedProject } from '../application/managed-projects.js';

export interface ManagedProjectLocationPort {
  home: string;
  location(id: string): string;
  placement(project: ManagedProject): { root: string; parent: string; privateDirectory: string; legacy: boolean };
}
/** Only an explicit launcher-selected Home changes new destinations; retained checkout identities never move. */
export function managedProjectLocations(stateDirectory: string, homeDirectory?: string): ManagedProjectLocationPort {
  if (homeDirectory !== undefined && !isAbsolute(homeDirectory)) throw new DomainError('invalid_input', 'Werk Home must be an absolute launcher-selected directory.');
  const state = resolve(stateDirectory), home = homeDirectory ? join(resolve(homeDirectory), 'projects') : join(state, 'projects');
  const location = (id: string) => homeDirectory ? join(home, id) : join(home, id, 'checkout');
  return { home, location, placement(project) {
    const legacyPath = join(state, 'projects', project.id, 'checkout'), legacy = project.path === legacyPath;
    if (!legacy && (!homeDirectory || project.path !== location(project.id))) throw new DomainError('conflict', 'The managed checkout path changed. Preserve its registered location before continuing.');
    return { root: legacy ? join(state, 'projects') : home, parent: dirname(project.path),
      privateDirectory: legacy ? dirname(project.path) : join(state, 'managed-projects', project.id), legacy };
  } };
}
