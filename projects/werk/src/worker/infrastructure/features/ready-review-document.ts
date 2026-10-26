import { DomainError } from '../../../shared/errors.js';
import { canonicalJson } from '../../application/request-gates.js';
import type { SharedFeatureRecord } from '../../application/shared-feature-state.js';
import { parseFeature } from './document.js';
import { renderSharedSource } from './shared-source.js';
import { sharedReadyReviewParts, sharedSourceProjectionKeys } from './shared-progress.js';

/** Human edits are read from pushed Git; exact generated report/metadata must be retained. */
export function readReadyReviewResponse(markdown: string, record: SharedFeatureRecord) {
  const parsed = parseFeature(markdown), expected = parseFeature(record.publishedSource ?? renderSharedSource(record));
  if (parsed.data.id !== record.id || parsed.data.templateId !== expected.data.templateId || canonicalJson(parsed.data.werk) !== canonicalJson(expected.data.werk)
      || sharedSourceProjectionKeys.some(key => canonicalJson(parsed.data[key]) !== canonicalJson(expected.data[key]))) throw Error('Keep the Feature Request identity and worker metadata unchanged while answering its Ready Check.');
  const parts = sharedReadyReviewParts(parsed);
  if (!parts) throw Error('Keep the generated Ready Check report and answer markers unchanged. Write your reply only in Answers and the original request details.');
  const status = String(parsed.data.status);
  for (const key of ['werk', ...sharedSourceProjectionKeys]) parsed.document.delete(key);
  parsed.document.set('status', 'ready');
  const sourceMarkdown = '---\n' + parsed.document.toString({ lineWidth: 0 }) + '---\n' + parts.body;
  return { sourceMarkdown, answer: parts.answer.replace(/<!--[\s\S]*?(?:-->|$)/g, '').trim(), status };
}


/** Change only the human Answers bytes and readiness status, retaining the validated generated report. */
export function writeReadyReviewAnswer(markdown: string, record: SharedFeatureRecord, answer: string): string {
  const before = readReadyReviewResponse(markdown, record), parsed = parseFeature(markdown);
  const combined = [before.answer, answer].filter(value => value.trim()).join('\n\n');
  if (!answer.trim() || combined.length > 8000 || combined.includes('<!-- werk:') || combined.includes('<!-- /werk:')) throw new DomainError('invalid_input', 'Keep the combined Ready Check answers within 8,000 characters and preserve its generated markers.');
  const begin = '<!-- werk:ready-review:answer -->\n', end = '\n<!-- /werk:ready-review:answer -->';
  const start = parsed.body.lastIndexOf(begin) + begin.length, finish = parsed.body.indexOf(end, start);
  if (start < begin.length || finish < start) throw new DomainError('conflict', 'The Ready Check answer markers changed. Refresh the canonical Feature Request.');
  parsed.body = parsed.body.slice(0, start) + combined + parsed.body.slice(finish);
  parsed.document.set('status', 'ready');
  const next = '---\n' + parsed.document.toString({ lineWidth: 0 }) + '---\n' + parsed.body;
  const checked = readReadyReviewResponse(next, record);
  if (checked.status !== 'ready' || checked.answer !== combined || checked.sourceMarkdown !== before.sourceMarkdown) throw new DomainError('invalid_input', 'The answer must contain plain response text without changing the request or generated report.');
  return next;
}


/** A distinct Git capability may append Answers, while ordinary lifecycle publication keeps them immutable. */
export function readyReviewAnswerPublicationAllowed(before: string, after: string, workerId: string): boolean {
  try {
    const old = parseFeature(before), next = parseFeature(after), prior = sharedReadyReviewParts(old), reply = sharedReadyReviewParts(next);
    const owner = (old.data.werk as { shared?: { owner?: unknown } } | undefined)?.shared?.owner;
    if (!prior || !reply || owner !== workerId || old.data.status !== 'waiting_ready_input' || next.data.status !== 'ready' || prior.body !== reply.body || canonicalJson({ ...old.data, status: 'ready' }) !== canonicalJson(next.data)) return false;
    const prefix = prior.answer ? prior.answer + '\n\n' : '';
    return reply.answer.length <= 8000 && reply.answer.startsWith(prefix) && !!reply.answer.slice(prefix.length).trim();
  } catch { return false; }
}
