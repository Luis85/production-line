import { DomainError } from '../../shared/errors.js';
import type { ChatMessage } from './conversation.js';
import type { InteractionTurn } from './interactions.js';
import type { WorkerRequest } from './request-gates.js';
import type { WorkerRun } from './run-evidence.js';
import type { SessionView } from './workspace-view.js';

/** Inputs stay private. Projection below deliberately excludes dispatches, contexts and file contents. */
export interface FeatureTrackingInput {
  session: SessionView['records'][number];
  messages?: readonly ChatMessage[];
  request?: WorkerRequest | null;
  turns?: readonly InteractionTurn[];
  runs?: readonly WorkerRun[];
  local?: { instruction: string; summary: string | null; error: string | null; hasPatch: boolean; repository?: string; paths?: readonly string[] };
  sourcePath?: string;
}
export interface FeatureTrackingRecord {
  sessionId: string; taskId: string; filename: string; path: string; revision: string; updatedAt: string; status: string;
}
export type FeatureTrackingNote = FeatureTrackingRecord & { markdown: string };
export interface FeatureTrackingStatus {
  directory: string; lastSyncedAt: string | null; error: string | null; records: FeatureTrackingRecord[];
}
export interface FeatureTrackingProjection {
  sessionId: string; taskId: string; title: string; source: string; provider: string;
  status: string; createdAt: string; archived: boolean; instructions: string; sourcePath?: string;
  request: { id: string; phase: string; inputRevision: number; ready: string; done: string; criteria: string[]; findings: string[] } | null;
  pending: { kind: string; message: string; choices: string[]; reason?: string } | null;
  activity: Array<{ at: string; label: string; input: string; result: string | null }>;
  attempts: Array<{ id: string; attempt: number; purpose: string; outcome: string; startedAt: string | null; finishedAt: string | null }>;
  result: string | null; hasPatch: boolean; approvedPaths: string[];
}
export interface FeatureTrackingDocuments {
  readonly directory: string;
  init(): Promise<void>;
  write(projection: FeatureTrackingProjection): Promise<FeatureTrackingRecord>;
  read(sessionId: string): Promise<FeatureTrackingNote>;
}
const clip = (value: string, limit = 16000) => value.length <= limit ? value : value.slice(0, limit) + '\n\n[Excerpt ends here. Full evidence remains in the worker.]';
const line = (value: string) => value.replace(/[\r\n\t]/g, ' ').trim();
const stateLabel = (value: string) => (({ completed: 'Turn completed', review: 'Ready for human review', done: 'Request checks passed', needs_rework: 'Needs rework', waiting_input: 'Waiting for an answer', escalated: 'Decision needed', queued: 'Queued', running: 'In progress', draft: 'Draft', failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Stopped', readiness: 'Readiness checks', ready: 'Ready' } as Record<string, string>)[value] ?? value.replaceAll('_', ' '));
function gateResult(request: WorkerRequest, stage: 'ready' | 'done') {
  const evaluation = request.evaluations.findLast(item => item.stage === stage && item.inputRevision === request.inputRevision && item.inputHash === request.inputHash && item.policyDigest === request.policyDigest && (stage === 'ready' || item.outputDigest === request.execution?.outputDigest));
  return !evaluation ? 'Not evaluated for the current input' : evaluation.passed ? 'Passed' : evaluation.rules.some(rule => rule.result === 'unknown') ? 'Not confirmed' : 'Not passed';
}
function patchSummary(text: string): string {
  try { const value: unknown = JSON.parse(text); if (value && typeof value === 'object' && typeof (value as { summary?: unknown }).summary === 'string') return clip((value as { summary: string }).summary); }
  catch { /* A malformed patch is not a human-readable result. */ }
  return 'Patch response retained in the worker. Inspect its validation and review evidence.';
}
function remoteResult(text: string): string {
  try {
    const value = JSON.parse(text) as { execution?: { outcome?: unknown; mode?: unknown }; quality?: { passed?: unknown }; review?: unknown };
    if (value && typeof value === 'object' && value.execution && value.quality) {
      const outcome = typeof value.execution.outcome === 'string' ? value.execution.outcome : 'Recorded';
      return `Assignment result: ${line(outcome)}. ${value.review ? 'A proposed change has review evidence. ' : ''}Inspect the owning orchestrator and worker history for full evidence.`;
    }
  } catch { /* Plain-text cancellation messages and follow-ups remain readable. */ }
  return clip(text);
}
export function projectFeatureTracking(input: FeatureTrackingInput): FeatureTrackingProjection | null {
  const { session, request, local } = input;
  const messages = input.messages ?? [], turns = [...(input.turns ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (session.id === 'default' && !session.messages && !messages.length && !request && !turns.length) return null;
  const instructions = local?.instruction ?? request?.input.message ?? (session.kind === 'local' ? undefined : messages.find(message => message.role === 'user')?.text ?? turns[0]?.input) ?? '';
  const activity: FeatureTrackingProjection['activity'] = turns.slice(-60).map(turn => ({
    at: turn.createdAt, label: `${turn.kind === 'answer' ? 'Answer' : turn.kind === 'resume' ? 'Continuation' : 'Instructions'} · ${stateLabel(turn.status)}`,
    input: session.kind === 'local' && turn.dispatch?.operation !== 'chat' && (turn.kind === 'message' || turn.input.includes('Approved file snapshots:')) ? '' : clip(turn.input, 8000), result: turn.result?.type === 'completed' ? turn.dispatch?.operation === 'patch' || session.kind === 'local' && !turn.dispatch ? patchSummary(turn.result.text) : session.kind === 'orchestrator' ? remoteResult(turn.result.text) : clip(turn.result.text) : turn.result?.type === 'needs_input' ? clip(turn.result.request.message, 8000) : null,
  }));
  // Imported and remote sessions can have a transcript without local interaction turns.
  // Approved-file transcripts contain private snapshots, so they never enter this fallback.
  if (!turns.length && !local && session.kind !== 'local') for (const message of messages.slice(-60)) {
    activity.push({ at: message.at, label: `${message.role === 'user' ? 'Instructions' : 'Worker response'} · ${stateLabel(message.state === 'complete' ? 'completed' : message.state)}`, input: message.role === 'user' ? clip(message.text, 8000) : '', result: message.role === 'assistant' && message.state !== 'pending' ? session.kind === 'orchestrator' ? remoteResult(message.text) : clip(message.text) : null });
  }
  const pending = session.interaction.pending;
  const latestReply = messages.filter(message => message.role === 'assistant' && message.state !== 'pending').at(-1);
  const completed = turns.findLast(turn => turn.result?.type === 'completed');
  const completedResult = completed?.result?.type === 'completed' ? completed.dispatch?.operation === 'patch' || session.kind === 'local' && !completed.dispatch ? patchSummary(completed.result.text) : session.kind === 'orchestrator' ? remoteResult(completed.result.text) : clip(completed.result.text) : null;
  const result = completedResult ?? local?.summary ?? local?.error ?? session.continuationBlockedReason ?? (!turns.length && latestReply && session.kind !== 'local' ? session.kind === 'orchestrator' ? remoteResult(latestReply.text) : clip(latestReply.text) : null);
  return {
    sessionId: session.id, taskId: session.taskId, title: session.title, source: session.kind, provider: session.provider,
    status: session.status, createdAt: session.createdAt, archived: session.archived, instructions: clip(instructions, 8000), ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
    request: request ? { id: request.id, phase: request.phase, inputRevision: request.inputRevision, ready: gateResult(request, 'ready'), done: gateResult(request, 'done'), criteria: (request.input.criteria ?? []).map(value => clip(value, 2000)), findings: request.findings.filter(finding => finding.status === 'open').map(finding => `${finding.blocking ? 'Blocking' : 'Advisory'} ${finding.kind}: ${clip(finding.message, 2000)}`) } : null,
    pending: pending ? { kind: pending.kind, message: clip(pending.message, 8000), choices: (pending.choices ?? []).map(choice => clip(choice.label, 240)), ...(pending.reason ? { reason: clip(pending.reason, 2000) } : {}) } : null,
    activity, attempts: [...(input.runs ?? [])].sort((a, b) => (a.acceptedAt ?? a.startedAt ?? '').localeCompare(b.acceptedAt ?? b.startedAt ?? '') || a.attempt - b.attempt).slice(-60).map(run => ({ id: run.id, attempt: run.attempt, purpose: run.purpose ?? 'execution', outcome: run.outcome, startedAt: run.startedAt ?? null, finishedAt: run.after?.capturedAt ?? null })),
    result: result === null || result === undefined ? null : clip(result), hasPatch: local?.hasPatch ?? false, approvedPaths: [...(local?.paths ?? request?.input.files?.map(file => file.path) ?? [])],
  };
}
/** Generated Markdown remains a projection, never an intake document or a command. */
export function renderFeatureTracking(value: FeatureTrackingProjection, metadata: { owner: string; digest: string; updatedAt: string }): string {
  const frontmatter = Object.entries({ schemaVersion: 1, type: 'feature-request', source: 'worker-tracking', taskKind: value.source, sessionId: value.sessionId, taskId: value.taskId, title: value.title, status: value.status, requestPhase: value.request?.phase ?? null, provider: value.provider, createdAt: value.createdAt, updatedAt: metadata.updatedAt, archived: value.archived, ...(value.sourcePath ? { sourcePath: value.sourcePath } : {}), werkTracking: { owner: metadata.owner, digest: metadata.digest } }).map(([key, field]) => key + ': ' + JSON.stringify(field)).join('\n');
  const paragraphs = [
    `---\n${frontmatter}\n---\n# ${line(value.title)}\n`,
    '> Maintained by the worker from saved task evidence. Follow-ups update this request. Editing this generated note does not submit work, answer a question or approve a change.\n',
    `## Request\n\n${value.instructions || 'No instructions have been submitted yet.'}\n`,
    `## Progress\n\n- Task status: ${stateLabel(value.status)}\n- Request checks: ${value.request ? stateLabel(value.request.phase) : 'Not evaluated'}\n- Readiness: ${value.request?.ready ?? 'Not evaluated'}\n- Completion checks: ${value.request?.done ?? 'Not evaluated'}\n- Provider: ${line(value.provider)}\n- Task: \`${value.taskId}\`\n- Session: \`${value.sessionId}\`\n`,
  ];
  if (value.hasPatch) paragraphs.push('A proposed patch is available in the worker. Human review is still required; this note does not mean files were changed or tests passed.\n');
  if (value.sourcePath) paragraphs.push(`Original request: ${line(value.sourcePath)}\n`);
  if (value.approvedPaths.length) paragraphs.push('### Approved files\n\n' + value.approvedPaths.map(path => '- ' + line(path)).join('\n') + '\n');
  if (value.request?.criteria.length) paragraphs.push('## Acceptance criteria\n\n' + value.request.criteria.map(criterion => '- ' + line(criterion)).join('\n') + '\n');
  if (value.request?.findings.length) paragraphs.push('## Open questions and gaps\n\n' + value.request.findings.map(finding => '- ' + line(finding)).join('\n') + '\n');
  if (value.pending) paragraphs.push('## Your input is needed\n\n' + value.pending.message + '\n' + (value.pending.choices.length ? '\n' + value.pending.choices.map(choice => '- ' + line(choice)).join('\n') + '\n' : '') + (value.pending.reason ? '\n' + value.pending.reason + '\n' : '') + '\nAnswer or resume this task in the worker.\n');
  paragraphs.push('## Latest recorded outcome\n\nEarlier outcomes remain visible while another turn is pending.\n\n' + (value.result ?? 'No completed result has been recorded yet.') + '\n');
  if (value.activity.length) paragraphs.push('## Activity and follow-ups\n\nMost recent retained activity; full execution evidence remains in the worker.\n\n' + value.activity.map(item => `### ${line(item.at)} · ${line(item.label)}\n\n${item.input ? item.input + '\n\n' : ''}${item.result ?? 'No completed response recorded for this entry.'}\n`).join('\n'));
  if (value.attempts.length) paragraphs.push('## Execution attempts\n\n' + value.attempts.map(attempt => `- Attempt ${attempt.attempt} · ${line(attempt.purpose)} · ${line(attempt.outcome)} · ${attempt.startedAt ?? 'Not started'}${attempt.finishedAt ? ' → ' + attempt.finishedAt : ''} · \`${attempt.id}\``).join('\n') + '\n');
  return paragraphs.join('\n');
}

/** Serialized projection writes never admit work or change the owning task's lifecycle. */
export class FeatureTracking {
  private records = new Map<string, FeatureTrackingRecord>();
  private lastSyncedAt: string | null = null;
  private error: string | null = null;
  private working = false;
  private waiters: Array<(value: FeatureTrackingStatus) => void> = [];
  private closed = false;
  private closing?: Promise<FeatureTrackingStatus>;
  private documents: FeatureTrackingDocuments;
  private snapshot: () => FeatureTrackingInput[];
  constructor(documents: FeatureTrackingDocuments, snapshot: () => FeatureTrackingInput[]) { this.documents = documents; this.snapshot = snapshot; }
  status(): FeatureTrackingStatus { return { directory: this.documents.directory, lastSyncedAt: this.lastSyncedAt, error: this.error, records: [...this.records.values()].map(record => ({ ...record })) }; }
  record(sessionId: string): FeatureTrackingRecord | undefined { const value = this.records.get(sessionId); return value && { ...value }; }
  init() { return this.sync(); }
  sync(): Promise<FeatureTrackingStatus> {
    if (this.closed) return Promise.resolve(this.status());
    const result = new Promise<FeatureTrackingStatus>(resolve => this.waiters.push(resolve));
    if (!this.working) void this.pump();
    return result;
  }
  private async pump() {
    this.working = true;
    try {
      while (this.waiters.length) {
        const waiters = this.waiters.splice(0);
        const errors: string[] = [];
        try {
          await this.documents.init();
          const inputs = this.snapshot();
          for (const input of inputs) {
            const projection = projectFeatureTracking(input);
            if (!projection) continue;
            try { this.records.set(projection.sessionId, await this.documents.write(projection)); }
            catch { errors.push(projection.sessionId); }
          }
          this.error = errors.length ? `Feature-request Markdown could not be saved for ${errors.length} task${errors.length === 1 ? '' : 's'}. Check the tracking folder and file ownership, then refresh. Previously saved notes may be stale.` : null;
          if (!errors.length) this.lastSyncedAt = new Date().toISOString();
        } catch { this.error = 'Feature-request Markdown is unavailable. Check the tracking folder and worker state permissions, then refresh. Previously saved notes may be stale.'; }
        const status = this.status();
        for (const resolve of waiters) resolve(status);
      }
    } finally { this.working = false; }
  }
  async get(sessionId: string) {
    if (!this.records.has(sessionId)) throw new DomainError('not_found', 'No saved feature-request note is available for this task. Refresh to retry tracking.');
    return this.documents.read(sessionId);
  }
  close(): Promise<FeatureTrackingStatus> { return this.closing ??= this.sync().then(status => { this.closed = true; return status; }); }
}
