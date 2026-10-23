import { createHash } from 'node:crypto';
import type { FeatureInput } from './feature-requests.js';

export interface FeatureMarkdownCommand {
  commandId: string;
  action: import('./remote-delivery-contracts.js').RemotePublicationCommand | 'readiness_decision' | 'criterion_decision' | 'accept' | 'request_changes' | 'reopen' | 'pause_after_step' | 'interrupt' | 'cancel' | 'resume' | 'retry' | 'confirm_stopped';
  requestRevision?: number;
  candidateCommit?: string;
  runId?: string;
  publicationOperationId?: string;
  feedback?: string;
  inputHash?: string;
  assessmentId?: string;
  proposalId?: string;
  decision?: 'accepted' | 'rejected';
  criterionDecision?: import('./delivery-criterion-decisions.js').DeliveryCriterionDecisionInput;
  reviewDurationMinutes?: number;
  humanChecks?: { criterionId: string; outcome: 'pass' | 'fail' | 'exempt'; note: string }[];
}
export interface FeatureCommandReceipt {
  commandId: string; digest: string; command: import('./request-gates.js').RequestCommand;
  outcome?: 'accepted' | 'rejected'; message?: string;
}
export interface FeatureSourceIssue { code: 'missing_source' | 'invalid_source' | 'duplicate_identity' | 'changed_input'; reason: string; }

/** Preserve whitespace in code and meaningful Markdown hard breaks; normalize cosmetic blank lines. */
function semanticMarkdown(value: string) {
  let fence = '', blank = false;
  return value.replace(/\r\n?/g, '\n').split('\n').flatMap(line => {
    const boundary = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (boundary) { fence = fence ? boundary[1]![0] === fence[0] && boundary[1]!.length >= fence.length ? '' : fence : boundary[1]!; blank = false; return [line]; }
    if (fence || /^(?: {4}|\t)/.test(line)) { blank = false; return [line]; }
    const normalized = / {2,}$/.test(line) ? line.replace(/ {2,}$/, '  ') : line.trimEnd();
    if (!normalized) { if (blank) return []; blank = true; return ['']; }
    blank = false; return [normalized];
  }).join('\n').trim();
}
export function featureInputHash(input: FeatureInput) {
  const { priority: _priority, providerExplicit: _providerExplicit, ...semantic } = input;
  return createHash('sha256').update(JSON.stringify({ ...semantic, message: semanticMarkdown(input.message) })).digest('hex');
}
export const featureCommandDigest = (command: FeatureMarkdownCommand) => createHash('sha256').update(JSON.stringify(command)).digest('hex');

export function acceptedFeatureHash(record: { semanticRevision?: number; inputHash: string; input?: FeatureInput }) {
  return record.semanticRevision === undefined && record.input ? featureInputHash(record.input) : record.inputHash;
}

export function featureTaskIdentity(id: string, mode: 'chat' | 'patch', projectId?: string) {
  const taskId = 'feature-' + (projectId ? createHash('sha256').update(JSON.stringify([projectId, id])).digest('hex').slice(0, 40) : /^[a-z0-9-]+$/.test(id) ? id : createHash('sha256').update(id).digest('hex').slice(0, 40));
  return { taskId, sessionId: mode === 'patch' ? 'local-' + taskId : taskId };
}
