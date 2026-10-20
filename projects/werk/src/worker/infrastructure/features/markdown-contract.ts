import { remotePublicationCommands } from '../../application/remote-delivery-contracts.js';
import type { FeatureMarkdownCommand } from '../../application/feature-markdown.js';
import type { FeatureDocument } from './document.js';

export const requestSchema = 'worker.request/v1';
export const managedBegin = '<!-- worker:begin -->';
export const managedEnd = '<!-- worker:end -->';
export function authorBody(body: string) {
  const starts = body.split(managedBegin), ends = body.split(managedEnd);
  if (starts.length === 1 && ends.length === 1) return body;
  if (starts.length !== 2 || ends.length !== 2 || body.indexOf(managedBegin) > body.indexOf(managedEnd)) throw Error('Use one complete worker-managed region; keep its begin/end markers intact.');
  return body.slice(0, body.indexOf(managedBegin)) + body.slice(body.indexOf(managedEnd) + managedEnd.length);
}
export function managedBody(body: string) {
  authorBody(body);
  return body.includes(managedBegin) ? body.slice(body.indexOf(managedBegin), body.indexOf(managedEnd) + managedEnd.length) : undefined;
}
export function replaceManagedBody(body: string, generated: string) {
  authorBody(body);
  if (!body.includes(managedBegin)) return body.replace(/\s*$/, '\n\n') + generated + '\n';
  return body.slice(0, body.indexOf(managedBegin)) + generated + body.slice(body.indexOf(managedEnd) + managedEnd.length);
}
export function submissionIntent(data: Record<string, unknown>): 'draft' | 'submit' | undefined {
  if (data.schema === requestSchema) return data.intent as 'draft' | 'submit';
  return data.status === 'ready' ? 'submit' : data.status === 'draft' ? 'draft' : undefined;
}
const id = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) throw Error(`${name} must contain 1–100 letters, digits, underscores or hyphens.`);
  return value;
};
function fields(value: unknown, allowed: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw Error('Use the documented review/control fields.');
  return value as Record<string, unknown>;
}
export function markdownCommands(parsed: FeatureDocument): FeatureMarkdownCommand[] {
  const result: FeatureMarkdownCommand[] = [], data = parsed.data;
  for (const action of ['readiness_decision', 'criterion_decision'] as const) {
    if (data[action] === undefined) continue;
    const item = fields(data[action], action === 'readiness_decision'
      ? ['command_id', 'request_revision', 'input_hash', 'assessment_id', 'proposal_id', 'decision', 'note']
      : ['command_id', 'request_revision', 'run_id', 'candidate_commit', 'criterion_id', 'kind', 'reason']);
    if (!Number.isSafeInteger(item.request_revision) || Number(item.request_revision) < 1) throw Error('Decision request_revision must be a positive revision number.');
    const command: FeatureMarkdownCommand = { commandId: id(item.command_id, 'command_id'), action, requestRevision: Number(item.request_revision) };
    const note = action === 'readiness_decision' ? item.note : item.reason;
    if (typeof note !== 'string' || !note.trim() || note.length > 4000) throw Error('A decision needs a supporting reason (1–4,000 characters).');
    if (action === 'readiness_decision') {
      if (typeof item.input_hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.input_hash) || !['accepted', 'rejected'].includes(String(item.decision))) throw Error('A readiness decision requires the exact input_hash and accepted/rejected outcome.');
      Object.assign(command, { inputHash: item.input_hash, assessmentId: id(item.assessment_id, 'assessment_id'), proposalId: id(item.proposal_id, 'proposal_id'), decision: item.decision, feedback: note.trim() });
    } else {
      if (typeof item.candidate_commit !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(item.candidate_commit) || typeof item.criterion_id !== 'string' || !/^(?:check:[A-Za-z0-9_-]+|human:[1-9][0-9]*:[a-f0-9]{12})$/.test(item.criterion_id) || !['exempted', 'not_applicable'].includes(String(item.kind))) throw Error('A criterion decision needs an exact commit, documented criterion ID and exempted/not_applicable kind.');
      Object.assign(command, { runId: id(item.run_id, 'run_id'), candidateCommit: item.candidate_commit, criterionDecision: { criterionId: item.criterion_id, kind: item.kind, reason: note.trim() } });
    }
    result.push(command);
  }
  if (data.control !== undefined) {
    const control = fields(data.control, ['command_id', 'action', 'run_id', 'request_revision', 'note']);
    if (!['reopen', 'pause_after_step', 'interrupt', 'cancel', 'resume', 'retry', 'confirm_stopped'].includes(String(control.action))) throw Error('Unknown control action.');
    const command: FeatureMarkdownCommand = { commandId: id(control.command_id, 'command_id'), action: control.action as FeatureMarkdownCommand['action'] };
    if (control.action !== 'reopen' && (control.action !== 'cancel' || control.run_id !== undefined)) command.runId = id(control.run_id, 'run_id');
    if (control.request_revision !== undefined) { if (!Number.isSafeInteger(control.request_revision) || Number(control.request_revision) < 1) throw Error('request_revision must be a positive revision number.'); command.requestRevision = Number(control.request_revision); }
    if (control.note !== undefined) { if (typeof control.note !== 'string' || control.note.length > 4000) throw Error('Control note must be at most 4,000 characters.'); command.feedback = control.note; }
    if (control.action === 'confirm_stopped' && (command.requestRevision === undefined || !command.feedback?.trim())) throw Error('confirm_stopped needs an explicit request_revision and a note confirming you inspected and stopped the prior processes.');
    result.push(command);
  }
  if (data.publication !== undefined) {
    const publication = fields(data.publication, ['command_id', 'action', 'run_id', 'request_revision', 'candidate_commit', 'operation_id']);
    if (!remotePublicationCommands.includes(publication.action as typeof remotePublicationCommands[number])) throw Error('Unknown publication action.');
    if (!Number.isSafeInteger(publication.request_revision) || Number(publication.request_revision) < 1) throw Error('Publication request_revision must be a positive revision number.');
    if (typeof publication.candidate_commit !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(publication.candidate_commit)) throw Error('Publication candidate_commit must identify the complete Git commit.');
    const command: FeatureMarkdownCommand = { commandId: id(publication.command_id, 'command_id'), action: publication.action as FeatureMarkdownCommand['action'],
      runId: id(publication.run_id, 'run_id'), requestRevision: Number(publication.request_revision), candidateCommit: publication.candidate_commit };
    if (publication.action === 'reconcile_publication') command.publicationOperationId = id(publication.operation_id, 'operation_id');
    else if (publication.operation_id !== undefined) throw Error('operation_id is only used to identify the saved publication being reconciled.');
    result.push(command);
  }
  if (data.review !== undefined) {
    const review = fields(data.review, ['command_id', 'decision', 'request_revision', 'candidate_commit', 'human_checks', 'feedback', 'review_duration_minutes']);
    if (!['accept', 'request_changes'].includes(String(review.decision))) throw Error('review.decision must be accept or request_changes.');
    if (!Number.isSafeInteger(review.request_revision) || Number(review.request_revision) < 1) throw Error('Review request_revision must be a positive revision number.');
    if (typeof review.candidate_commit !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(review.candidate_commit)) throw Error('Review candidate_commit must identify the complete Git commit.');
    const command: FeatureMarkdownCommand = { commandId: id(review.command_id, 'command_id'), action: review.decision as 'accept' | 'request_changes', requestRevision: Number(review.request_revision), candidateCommit: review.candidate_commit };
    if (review.review_duration_minutes !== undefined) {
      if (typeof review.review_duration_minutes !== 'number' || !Number.isFinite(review.review_duration_minutes) || review.review_duration_minutes < 0 || review.review_duration_minutes > 1440) throw Error('Reported review duration must be between 0 and 1,440 minutes.');
      command.reviewDurationMinutes = review.review_duration_minutes;
    }
    if (review.decision === 'request_changes') {
      const section = /^## Review feedback\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(authorBody(parsed.body))?.[1]?.trim();
      const feedback = review.feedback ?? section;
      if (typeof feedback !== 'string' || !feedback.trim() || feedback.length > 4000) throw Error('Request changes needs feedback or a Review feedback section (1–4,000 characters).');
      command.feedback = feedback.trim();
    }
    if (review.human_checks !== undefined) {
      if (!Array.isArray(review.human_checks) || review.human_checks.length > 100) throw Error('human_checks must be a list of at most 100 criterion outcomes.');
      command.humanChecks = review.human_checks.map(value => {
        const check = fields(value, ['criterion_id', 'outcome', 'note']);
        if (!['pass', 'fail', 'exempt'].includes(String(check.outcome)) || typeof check.note !== 'string' || !check.note.trim() || check.note.length > 2000) throw Error('Human checks need criterion_id, pass/fail/exempt outcome and supporting note.');
        if (typeof check.criterion_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:.-]{0,199}$/.test(check.criterion_id)) throw Error('criterion_id must identify a documented check or criterion.');
        return { criterionId: check.criterion_id, outcome: check.outcome as 'pass' | 'fail' | 'exempt', note: check.note.trim() };
      });
      if (new Set(command.humanChecks.map(check => check.criterionId)).size !== command.humanChecks.length) throw Error('Human check criterion IDs must be unique.');
    }
    result.push(command);
  }
  return result;
}
