import { createHash } from 'node:crypto';
import { DomainError } from '../../shared/errors.js';
import { identifier, object, text } from '../../shared/contracts.js';

export type FeatureRequestSource = 'interaction' | 'folder' | 'shared_git' | 'orchestrator';
/** Stable parent identity; execution requests, turns and transport notes are children. */
export interface FeatureRequestReference {
  key: string;
  id: string;
  source: FeatureRequestSource;
  scope: string;
  sourcePath?: string;
  repositoryId?: string;
}
export function featureRequestReference(input: Omit<FeatureRequestReference, 'key'>): FeatureRequestReference {
  const value = object(input, 'Feature request reference', ['id', 'source', 'scope', 'sourcePath', 'repositoryId']);
  const id = identifier(value.id, 'Feature request ID'), scope = text(value.scope, 'Feature request scope', 4096);
  if (typeof value.source !== 'string' || !['interaction', 'folder', 'shared_git', 'orchestrator'].includes(value.source))
    throw new DomainError('invalid_input', 'Unknown feature request source.');
  const source = value.source as FeatureRequestSource;
  const key = 'fr-' + createHash('sha256').update(JSON.stringify([source, scope, id])).digest('hex');
  return { key, id, source, scope,
    ...(value.sourcePath === undefined ? {} : { sourcePath: text(value.sourcePath, 'Feature request path', 4096) }),
    ...(value.repositoryId === undefined ? {} : { repositoryId: identifier(value.repositoryId, 'Feature request repository') }),
  };
}
export function validateFeatureRequestReference(input: unknown): FeatureRequestReference {
  const value = object(input, 'Feature request reference', ['key', 'id', 'source', 'scope', 'sourcePath', 'repositoryId']);
  const { key, ...identity } = value;
  const reference = featureRequestReference(identity as unknown as Omit<FeatureRequestReference, 'key'>);
  if (key !== reference.key) throw new DomainError('invalid_input', 'Feature request identity does not match its source.');
  return reference;
}
export const interactionFeatureRequest = (id: string) => featureRequestReference({ id, source: 'interaction', scope: 'worker-local' });
/** Older sessions retain their IDs; deriving a reference never submits or replays work. */
export function sessionFeatureRequest(record: { id: string; taskId?: string; kind?: string; feature?: FeatureRequestReference }): FeatureRequestReference {
  if (record.feature) return validateFeatureRequestReference(record.feature);
  const id = record.kind === 'local' && record.id.startsWith('local-') ? record.id.slice(6) : record.taskId ?? record.id;
  return record.kind === 'orchestrator'
    ? featureRequestReference({ id: id.startsWith('remote-') ? id.slice(7) : id, source: 'orchestrator', scope: 'legacy-worker-assignment' })
    : interactionFeatureRequest(id);
}

export function sharedFeatureRequestReference(record: {
  id: string; sourcePath: string;
  binding: { repositoryId: string; remote: string; branch: string; workflowPath: string };
}): FeatureRequestReference {
  const { repositoryId, remote, branch, workflowPath } = record.binding;
  return featureRequestReference({ id: record.id, source: 'shared_git', scope: JSON.stringify([repositoryId, remote, branch, workflowPath]), sourcePath: record.sourcePath, ...(repositoryId ? { repositoryId } : {}) });
}
