import { createHash } from 'node:crypto';
import type { SharedReadyReviewCheckpoint } from './shared-feature-state.js';
const readyReviewStart = '\n\n<!-- werk:ready-review:v1 -->\n';
const readyReviewAnswerStart = '<!-- werk:ready-review:answer -->\n';
const readyReviewAnswerEnd = '\n<!-- /werk:ready-review:answer -->';
const readyReviewEnd = '\n<!-- /werk:ready-review:v1 -->\n';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function boundedReport(value: string): string {
  if (Buffer.byteLength(value) <= 20480) return value;
  let result = '', bytes = 0;
  for (const character of value) { const size = Buffer.byteLength(character); if (bytes + size > 20000) break; result += character; bytes += size; }
  return result + '\n\nThe report was shortened to keep this Markdown note safe to publish. Full findings remain available in the worker review details and will accompany your next review.\n';
}
const quoted = (value: string) => value.replaceAll('<!--', '&lt;!--').replace(/\r\n?/g, '\n').split('\n').map(line => '> ' + line).join('\n');
function readyReviewReport(state: SharedReadyReviewCheckpoint): string {
  const result = state.result;
  const findings = result?.findings.map((finding, index) => `${index + 1}. ${finding.kind === 'question' ? 'Question' : finding.kind === 'gap' ? 'Gap' : 'Issue'}${finding.blocking ? ' · blocks readiness' : ''}\n\n${quoted(finding.message)}\n`).join('\n');
  const report = '## Feature Request Ready Check\n\n'
    + `Attempt ${state.generation} · ${state.status.replaceAll('_', ' ')}.\n\n`
    + (result ? quoted(result.summary) + '\n\n' + (findings || 'No findings were returned.\n') : 'The worker is checking this request before its Definition of Ready.\n')
    + (state.gateIssues?.length ? '\n### Definition of Ready changes\n\n' + state.gateIssues.map(quoted).join('\n\n') + '\n' : '');
  return readyReviewStart + boundedReport(report)
    + '\n### Answers\n\nWrite answers between the markers below. You may also revise your original request details. Keep the request ID, worker metadata and generated report unchanged. Set status to ready, then commit and push to request another review. An unchanged request does not run again.\n\n'
    + readyReviewAnswerStart;
}
export function readyReviewSection(state: SharedReadyReviewCheckpoint): string {
  return readyReviewReport(state) + state.answer + readyReviewAnswerEnd + readyReviewEnd;
}
export function readyReviewProjection(state: SharedReadyReviewCheckpoint) {
  return { schemaVersion: 1, reportHash: hash(readyReviewReport(state)), generation: state.generation };
}
export function readyReviewParts(body: string, projection: unknown): { body: string; answer: string } | undefined {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) return;
  const p = projection as { schemaVersion?: unknown; reportHash?: unknown; generation?: unknown };
  if (p.schemaVersion !== 1 || typeof p.reportHash !== 'string' || !/^[a-f0-9]{64}$/.test(p.reportHash) || !Number.isSafeInteger(p.generation) || Number(p.generation) < 1) return;
  const start = body.lastIndexOf(readyReviewStart), answerStart = body.indexOf(readyReviewAnswerStart, start);
  if (start < 0 || answerStart < start || body.indexOf(readyReviewStart) !== start || !body.endsWith(readyReviewAnswerEnd + readyReviewEnd)) return;
  const boundary = answerStart + readyReviewAnswerStart.length;
  if (hash(body.slice(start, boundary)) !== p.reportHash) return;
  const answer = body.slice(boundary, -(readyReviewAnswerEnd.length + readyReviewEnd.length));
  if (answer.length > 8000 || answer.includes('<!-- werk:') || answer.includes('<!-- /werk:')) return;
  return { body: body.slice(0, start), answer };
}
export function readyReviewCandidate(markdown: string, answer: string): string {
  return markdown + (answer.trim() ? '\n\n## Ready Check answers\n\n' + answer.trim() + '\n' : '');
}
