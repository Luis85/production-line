import { DomainError } from '../../shared/errors.js';
import type { RequestJournal } from './journal-ports.js';
import type { SessionRecord } from './session-catalog.js';
import { featureRequestReference, sessionFeatureRequest, validateFeatureRequestReference, type FeatureRequestReference } from './feature-request-reference.js';

/** Backfill only parent references; accepted inputs, evidence and dispatch receipts stay unchanged. */
export function restoreFeatureRequestReferences(
  records: SessionRecord[], requests: Pick<RequestJournal, 'forSession' | 'bindFeature'>,
  source?: (record: SessionRecord) => FeatureRequestReference | undefined,
): boolean {
  let changed = false;
  for (const record of records) {
    const request = requests.forSession(record.id), remote = request?.owner.remote;
    const accepted = request?.input.context as { source?: { featureId?: string } } | undefined;
    const external = remote ? featureRequestReference({ id: accepted?.source?.featureId ?? remote.taskId, source: 'orchestrator', scope: remote.origin }) : source?.(record);
    const reference = external ? validateFeatureRequestReference(external) : sessionFeatureRequest(record);
    if (record.feature && record.feature.key !== reference.key)
      throw new DomainError('conflict', 'Saved session and source belong to different Feature Requests. Restore their original identity.');
    if (!record.feature) { record.feature = reference; changed = true; }
    requests.bindFeature(record.id, reference.key);
  }
  return changed;
}
