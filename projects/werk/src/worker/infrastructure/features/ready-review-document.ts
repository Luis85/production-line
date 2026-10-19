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
