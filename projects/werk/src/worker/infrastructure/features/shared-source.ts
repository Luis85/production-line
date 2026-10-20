import { validateModelSelection } from '../../application/model-selection.js';
import { readyReviewSection, readyReviewProjection } from '../../application/ready-review-notes.js';
import type { SharedBlob, SharedFeatureRecord } from '../../application/shared-feature-state.js';
import type { SharedFeatureView } from '../../application/shared-intake-contract.js';
import { sharedHash } from '../../application/shared-feature-notes.js';
import { sharedProgressSection } from './shared-progress.js';
import { dependencyId, parseFeature, renderFeature } from './document.js';

export function sharedSource(blob: SharedBlob) {
  const parsed = parseFeature(blob.content), data = parsed.data;
  const id = typeof data.id === 'string' ? data.id : undefined;
  const title = typeof data.title === 'string' ? data.title : blob.name;
  const status = typeof data.status === 'string' ? data.status : 'draft';
  const dependsOn = Array.isArray(data.depends_on) && data.depends_on.length <= 100 && data.depends_on.every(value => typeof value === 'string' && dependencyId.test(value)) ? [...data.depends_on as string[]] : [];
  const metadata = data.werk as Record<string, unknown> | undefined;
  if (!metadata?.shared) return { id, title, status, dependsOn };
  const s = metadata.shared as Record<string, unknown>;
  if (!s || typeof s !== 'object' || !id || typeof s.owner !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(s.owner) || typeof s.sourceCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(s.sourceCommit)) throw Error('Invalid shared lifecycle metadata.');
  const string = (value: unknown, max = 500): string | null => typeof value === 'string' && value.length <= max ? value : null;
  const checks = (value: unknown) => {
    if (!value || typeof value !== 'object') return null;
    const c = value as { passed?: unknown; issues?: unknown };
    return typeof c.passed === 'boolean' && Array.isArray(c.issues) && c.issues.length <= 64 && c.issues.every(i => typeof i === 'string' && i.length <= 2000) ? { passed: c.passed, issues: c.issues as string[] } : null;
  };
  const shared: SharedFeatureView = { ...(s.selection === undefined ? {} : { selection: validateModelSelection(s.selection) }), id, name: blob.name, title, status, owner: s.owner, isLocal: false, sourceCommit: s.sourceCommit, updatedAt: string(s.updatedAt, 50) ?? '', ready: checks(s.ready), done: checks(s.done), featureBranch: string(s.featureBranch), reviewNote: string(s.reviewNote), taskNote: string(s.taskNote), publication: 'synced', error: string(s.error), taskId: string(s.taskId, 100) };
  return { id, title, status, dependsOn, shared };
}
export function renderSharedSource(record: SharedFeatureRecord) {
  const parsed = parseFeature(record.sourceMarkdown);
  const progress = { schemaVersion: 1, summary: record.progress ?? `Worker status: ${record.status.replaceAll('_', ' ')}.`, sourceBodyHash: sharedHash(parsed.body), task: record.taskNote ?? null, review: record.reviewNote };
  parsed.document.set('werkOwner', record.owner);
  parsed.document.set('werkTask', record.taskNote ? `[[${record.taskNote.replace(/\.md$/, '')}]]` : null);
  parsed.document.set('werkPullRequest', record.reviewNote ? `[[${record.reviewNote.replace(/\.md$/, '')}]]` : null);
  if (record.readyReviewState) parsed.body += readyReviewSection(record.readyReviewState);
  return renderFeature(parsed, record.id, record.status, { shared: { schemaVersion: 1, ...(record.selection ? { selection: record.selection } : {}), ...(record.readyReviewState ? { readyReview: readyReviewProjection(record.readyReviewState) } : {}), owner: record.owner, sourceCommit: record.sourceCommit, sourceHash: record.inputHash, taskId: record.taskId, updatedAt: record.updatedAt, ready: record.ready, done: record.done, featureBranch: record.featureBranch, featureCommit: record.featureCommit ?? null, reviewNote: record.reviewNote, taskNote: record.taskNote ?? null, progress, policyDigest: record.workflow.policyDigest, readyCheck: record.workflow.files.readyCheck, doneCheck: record.workflow.files.doneCheck, ...(record.workflow.files.readyPrompt ? { readyPrompt: record.workflow.files.readyPrompt } : {}), ...(record.workflow.files.donePrompt ? { donePrompt: record.workflow.files.donePrompt } : {}), error: record.error } }) + sharedProgressSection(progress);
}
