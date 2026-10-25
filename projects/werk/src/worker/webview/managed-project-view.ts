export type { ManagedProjectsView } from '../application/managed-projects';
export interface ManagedProjectDraft { mode: 'register' | 'adopt'; intake: 'shared' | 'local'; id: string; name: string; repository: string; path: string; branch: string; featuresDirectory: string; }
export type ManagedProjectCommand =
  | { action: 'register'; operationId: string; id: string; name?: string; intake: 'shared' | 'local'; repository: string; branch: string; featuresDirectory: string }
  | { action: 'adopt'; operationId: string; id: string; name?: string; intake: 'shared' | 'local'; path: string; branch: string; featuresDirectory: string }
  | { action: 'reconcile' | 'retry'; operationId: string; id: string };
export const emptyManagedProjectDraft = (): ManagedProjectDraft => ({ mode: 'register', intake: 'shared', id: '', name: '', repository: '', path: '', branch: 'main', featuresDirectory: 'features' });
/** Freeze the submitted operation before transport so an uncertain reply replays the same request. */
export function managedProjectCommand(draft: ManagedProjectDraft, operationId: string): ManagedProjectCommand {
  const base = { operationId, intake: draft.intake, id: draft.id.trim(), ...(draft.name.trim() ? { name: draft.name.trim() } : {}), branch: draft.branch.trim() || 'main', featuresDirectory: draft.featuresDirectory.trim() || 'features' };
  return draft.mode === 'register' ? { ...base, action: 'register', repository: draft.repository.trim() } : { ...base, action: 'adopt', path: draft.path.trim() };
}
export const managedProjectStatus = { preparing: 'Preparing project', ready: 'Ready', needs_attention: 'Needs attention' };
