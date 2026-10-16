import type { SharedBlob, SharedFeatureRecord } from '../../application/shared-feature-state.js';
import type { SharedFeatureView } from '../../application/shared-intake-contract.js';
import { parseFeature, renderFeature } from './document.js';

export function sharedSource(blob: SharedBlob) {
  const parsed = parseFeature(blob.content), data = parsed.data;
  const id = typeof data.id === 'string' ? data.id : undefined;
  const title = typeof data.title === 'string' ? data.title : blob.name;
  const status = typeof data.status === 'string' ? data.status : 'draft';
  const metadata = data.werk as Record<string, unknown> | undefined;
  if (!metadata?.shared) return { id, title, status };
  const s = metadata.shared as Record<string, unknown>;
  if (!s || typeof s !== 'object' || !id || typeof s.owner !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(s.owner) || typeof s.sourceCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(s.sourceCommit)) throw Error('Invalid shared lifecycle metadata.');
  const string = (value: unknown, max = 500): string | null => typeof value === 'string' && value.length <= max ? value : null;
  const checks = (value: unknown) => {
    if (!value || typeof value !== 'object') return null;
    const c = value as { passed?: unknown; issues?: unknown };
    return typeof c.passed === 'boolean' && Array.isArray(c.issues) && c.issues.length <= 64 && c.issues.every(i => typeof i === 'string' && i.length <= 2000) ? { passed: c.passed, issues: c.issues as string[] } : null;
  };
  const shared: SharedFeatureView = { id, name: blob.name, title, status, owner: s.owner, isLocal: false, sourceCommit: s.sourceCommit, updatedAt: string(s.updatedAt, 50) ?? '', ready: checks(s.ready), done: checks(s.done), featureBranch: string(s.featureBranch), reviewNote: string(s.reviewNote), publication: 'synced', error: string(s.error), taskId: string(s.taskId, 100) };
  return { id, title, status, shared };
}
export function renderSharedSource(record: SharedFeatureRecord) {
  return renderFeature(parseFeature(record.sourceMarkdown), record.id, record.status, { shared: { schemaVersion: 1, owner: record.owner, sourceCommit: record.sourceCommit, sourceHash: record.inputHash, taskId: record.taskId, updatedAt: record.updatedAt, ready: record.ready, done: record.done, featureBranch: record.featureBranch, featureCommit: record.featureCommit ?? null, reviewNote: record.reviewNote, policyDigest: record.workflow.policyDigest, readyCheck: record.workflow.files.readyCheck, doneCheck: record.workflow.files.doneCheck, error: record.error } });
}
