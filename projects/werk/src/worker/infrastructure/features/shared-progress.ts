import { releaseMarkdown, type ReleaseProjection } from '../../application/release-markdown.js';
import { readyReviewParts } from '../../application/ready-review-notes.js';
import { createHash } from 'node:crypto';
import type { FeatureDocument } from './document.js';

/** Reserved presentation fields never change the accepted author-owned request. */
export const sharedSourceProjectionKeys = ['werkOwner', 'werkTask', 'werkPullRequest'] as const;
interface Progress { releaseJson?: string; schemaVersion: 1; summary: string; sourceBodyHash: string; task: string | null; review: string | null; reviewFeedback?: { operationId: string; inputRevision: number; candidateCommit: string; note: string }; }
function progress(value: unknown): Progress | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const p = value as Partial<Progress>;
  if (typeof p.sourceBodyHash !== 'string' || !/^[a-f0-9]{64}$/.test(p.sourceBodyHash) || p.schemaVersion !== 1 || typeof p.summary !== 'string' || p.summary.length > 2000 || ![p.task, p.review].every(path => path === null || typeof path === 'string' && /^[^\\\r\n\x00-\x1f\[\]]{1,500}\.md$/.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..'))) return;
  const feedback = p.reviewFeedback;
  if (feedback !== undefined && (!feedback || typeof feedback.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(feedback.operationId) || !Number.isSafeInteger(feedback.inputRevision) || feedback.inputRevision < 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(feedback.candidateCommit) || typeof feedback.note !== 'string' || !feedback.note.trim() || feedback.note.length > 4000)) return;
  if (p.releaseJson !== undefined) {
    if (typeof p.releaseJson !== 'string' || p.releaseJson.length > 65536) return;
    try { const release = JSON.parse(p.releaseJson) as ReleaseProjection; if (!release || !Array.isArray(release.operations) || release.operations.length > 32) return; } catch { return; }
  }
  return p as Progress;
}
export function sharedProgressSection(value: unknown): string {
  const p = progress(value);
  if (!p) return '';
  const links = [p.task ? `- Action needed: [[${p.task.replace(/\.md$/, '')}]]` : '', p.review ? `- Pull request: [[${p.review.replace(/\.md$/, '')}]]` : ''].filter(Boolean);
  const feedback = p.reviewFeedback ? '\n### Review feedback\n\n' + p.reviewFeedback.note.replace(/\r\n?/g, '\n').split('\n').map(line => '> ' + line).join('\n') + `\n\nFeedback operation: ${p.reviewFeedback.operationId} · request revision ${p.reviewFeedback.inputRevision} · candidate ${p.reviewFeedback.candidateCommit}\n` : '';
  return '\n\n<!-- werk:progress:v1 -->\n## Worker progress\n\n' + p.summary.replace(/[\r\n]+/g, ' ') + '\n' + (links.length ? '\n' + links.join('\n') + '\n' : '') + feedback + (p.releaseJson ? '\n' + releaseMarkdown(JSON.parse(p.releaseJson) as ReleaseProjection) + '\n' : '') + '\n<!-- /werk:progress:v1 -->\n';
}
export function sharedReadyReviewParts(parsed: FeatureDocument) {
  const metadata = parsed.data.werk as { shared?: { progress?: unknown; readyReview?: unknown } } | undefined;
  const value = progress(metadata?.shared?.progress), section = sharedProgressSection(value);
  const body = value && section && parsed.body.endsWith(section) ? parsed.body.slice(0, -section.length) : parsed.body;
  return readyReviewParts(body, metadata?.shared?.readyReview);
}
export function acceptedSharedBody(parsed: FeatureDocument): string {
  const reviewed = sharedReadyReviewParts(parsed);
  if (reviewed) return reviewed.body;
  const metadata = parsed.data.werk as { shared?: { progress?: unknown } } | undefined;
  const value = progress(metadata?.shared?.progress), section = sharedProgressSection(value);
  if (!value || !section || !parsed.body.endsWith(section)) return parsed.body;
  const original = parsed.body.slice(0, -section.length);
  return createHash('sha256').update(original).digest('hex') === value.sourceBodyHash ? original : parsed.body;
}
