import { sessionFeatureRequest,                              } from './feature-request-reference.js';
import { DomainError } from '../../shared/errors.js';
                                                     
                                                         
                                                        
                                                   
                                                       
                                                                                  
import { projectDevelopmentEvidence, renderDevelopmentEvidence,                                } from './development-notes.js';

/** Inputs stay private. Projection below deliberately excludes dispatches, contexts and file contents. */
                                       
                                          
                                    
                                 
                                     
                              
                                                                                                                                                                                                                                     
                      
 
                                        
                                                                                                                         
 
                                                                               
                                        
                                                                                                         
 
                                            
                                   
                                                                                     
                                                                                                  
                                                                                                                                            
                                                                                        
                                                                                       
                                                                                                                                          
                                                                                                             
 
                                           
                             
                        
                                                                               
                                                        
 
const clip = (value        , limit = 16000) => value.length <= limit ? value : value.slice(0, limit) + '\n\n[Excerpt ends here. Full evidence remains in the worker.]';
const line = (value        ) => value.replace(/[\r\n\t]/g, ' ').trim();
const stateLabel = (value        ) => (({ completed: 'Turn completed', review: 'Ready for human review', done: 'Request checks passed', needs_rework: 'Needs rework', waiting_input: 'Waiting for an answer', escalated: 'Decision needed', queued: 'Queued', running: 'In progress', draft: 'Draft', failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Stopped', readiness: 'Readiness checks', ready: 'Ready' }                          )[value] ?? value.replaceAll('_', ' '));
function gateResult(request               , stage                  ) {
  const evaluation = request.evaluations.findLast(item => item.stage === stage && item.inputRevision === request.inputRevision && item.inputHash === request.inputHash && item.policyDigest === request.policyDigest && (stage === 'ready' || item.outputDigest === request.execution?.outputDigest));
  return !evaluation ? 'Not evaluated for the current input' : evaluation.passed ? 'Passed' : evaluation.rules.some(rule => rule.result === 'unknown') ? 'Not confirmed' : 'Not passed';
}
function patchSummary(text        )         {
  try { const value          = JSON.parse(text); if (value && typeof value === 'object' && typeof (value                         ).summary === 'string') return clip((value                       ).summary); }
  catch { /* A malformed patch is not a human-readable result. */ }
  return 'Patch response retained in the worker. Inspect its validation and review evidence.';
}
function remoteResult(text        )         {
  try {
    const value = JSON.parse(text)                                                                                                           ;
    if (value && typeof value === 'object' && value.execution && value.quality) {
      const outcome = typeof value.execution.outcome === 'string' ? value.execution.outcome : 'Recorded';
      return `Assignment result: ${line(outcome)}. ${value.review ? 'A proposed change has review evidence. ' : ''}Inspect the owning orchestrator and worker history for full evidence.`;
    }
  } catch { /* Plain-text cancellation messages and follow-ups remain readable. */ }
  return clip(text);
}
function turnResult(turn                 , source        , worktree         )                {
  if (turn.result?.type === 'needs_input') return clip(turn.result.request.message, 8000);
  if (turn.result?.type !== 'completed') return null;
  const legacyPatch = turn.dispatch?.operation === 'patch' && turn.dispatch.policy?.development !== true || source === 'local' && !turn.dispatch && !worktree;
  return legacyPatch ? patchSummary(turn.result.text) : source === 'orchestrator' ? remoteResult(turn.result.text) : clip(turn.result.text);
}
export function projectFeatureTracking(input                      )                                   {
  const { session, request, local } = input;
  const messages = input.messages ?? [], turns = [...(input.turns ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (session.id === 'default' && !session.messages && !messages.length && !request && !turns.length) return null;
  const instructions = local?.instruction ?? request?.input.message ?? (session.kind === 'local' ? undefined : messages.find(message => message.role === 'user')?.text ?? turns[0]?.input) ?? '';
  const activity                                        = turns.slice(-60).map(turn => ({
    at: turn.createdAt, label: `${turn.kind === 'answer' ? 'Answer' : turn.kind === 'resume' ? 'Continuation' : 'Instructions'} · ${stateLabel(turn.status)}`,
    input: session.kind === 'local' && turn.dispatch?.operation !== 'chat' && (turn.kind === 'message' || turn.input.includes('Approved file snapshots:')) ? '' : clip(turn.input, 8000), result: turnResult(turn, session.kind, !!local?.implementation),
  }));
  // Imported and remote sessions can have a transcript without local interaction turns.
  // Approved-file transcripts contain private snapshots, so they never enter this fallback.
  if (!turns.length && !local && session.kind !== 'local') for (const message of messages.slice(-60)) {
    activity.push({ at: message.at, label: `${message.role === 'user' ? 'Instructions' : 'Worker response'} · ${stateLabel(message.state === 'complete' ? 'completed' : message.state)}`, input: message.role === 'user' ? clip(message.text, 8000) : '', result: message.role === 'assistant' && message.state !== 'pending' ? session.kind === 'orchestrator' ? remoteResult(message.text) : clip(message.text) : null });
  }
  const pending = session.interaction.pending;
  const latestReply = messages.filter(message => message.role === 'assistant' && message.state !== 'pending').at(-1);
  const completed = turns.findLast(turn => turn.result?.type === 'completed');
  const completedResult = completed ? turnResult(completed, session.kind, !!local?.implementation) : null;
  const result = completedResult ?? local?.summary ?? local?.error ?? session.continuationBlockedReason ?? (!turns.length && latestReply && session.kind !== 'local' ? session.kind === 'orchestrator' ? remoteResult(latestReply.text) : clip(latestReply.text) : null);
  return {
    feature: sessionFeatureRequest(session),
    sessionId: session.id, taskId: session.taskId, title: session.title, source: session.kind, provider: session.provider,
    status: session.status, createdAt: session.createdAt, archived: session.archived, instructions: clip(instructions, 8000), ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
    request: request ? { id: request.id, phase: request.phase, inputRevision: request.inputRevision, ready: gateResult(request, 'ready'), done: gateResult(request, 'done'), criteria: (request.input.criteria ?? []).map(value => clip(value, 2000)), findings: request.findings.filter(finding => finding.status === 'open').map(finding => `${finding.blocking ? 'Blocking' : 'Advisory'} ${finding.kind}: ${clip(finding.message, 2000)}`) } : null,
    pending: pending ? { kind: pending.kind, message: clip(pending.message, 8000), choices: (pending.choices ?? []).map(choice => clip(choice.label, 240)), ...(pending.reason ? { reason: clip(pending.reason, 2000) } : {}) } : null,
    activity, attempts: [...(input.runs ?? [])].sort((a, b) => (a.acceptedAt ?? a.startedAt ?? '').localeCompare(b.acceptedAt ?? b.startedAt ?? '') || a.attempt - b.attempt).slice(-60).map(run => ({ id: run.id, attempt: run.attempt, purpose: run.purpose ?? 'execution', outcome: run.outcome, startedAt: run.startedAt ?? null, finishedAt: run.after?.capturedAt ?? null })),
    ...(local?.implementation ? { development: projectDevelopmentEvidence(local.implementation, local.developmentEvidence) } : {}),
    result: result === null || result === undefined ? null : clip(result), hasPatch: local?.hasPatch ?? false, approvedPaths: [...(local?.paths ?? request?.input.files?.map(file => file.path) ?? [])],
  };
}
/** Generated Markdown remains a projection, never an intake document or a command. */
export function renderFeatureTracking(value                           , metadata                                                      )         {
  const frontmatter = Object.entries({ schemaVersion: 1, type: ['folder', 'shared_git'].includes(value.feature.source) ? 'FeatureRequestProgress' : 'feature-request', featureRequestId: value.feature.id, featureRequestKey: value.feature.key, intakeSource: value.feature.source, source: 'worker-tracking', taskKind: value.source, sessionId: value.sessionId, taskId: value.taskId, title: value.title, status: value.status, requestPhase: value.request?.phase ?? null, provider: value.provider, createdAt: value.createdAt, updatedAt: metadata.updatedAt, archived: value.archived, ...(value.sourcePath ? { sourcePath: value.sourcePath } : {}), werkTracking: { owner: metadata.owner, digest: metadata.digest } }).map(([key, field]) => key + ': ' + JSON.stringify(field)).join('\n');
  const paragraphs = [
    `---\n${frontmatter}\n---\n# ${line(value.title)}\n`,
    ['folder', 'shared_git'].includes(value.feature.source)
      ? '> Execution progress for the linked Feature Request. This note is a projection, not another request. Answer its linked Task note or use the worker interaction.\n'
      : '> Maintained by the worker from saved task evidence. Follow-ups update this request. Editing this generated note does not submit work, answer a question or approve a change.\n',
    `## Request\n\n${value.instructions || 'No instructions have been submitted yet.'}\n`,
    `## Progress\n\n- Task status: ${stateLabel(value.status)}\n- Request checks: ${value.request ? stateLabel(value.request.phase) : 'Not evaluated'}\n- Readiness: ${value.request?.ready ?? 'Not evaluated'}\n- Completion checks: ${value.request?.done ?? 'Not evaluated'}\n- Provider: ${line(value.provider)}\n- Task: \`${value.taskId}\`\n- Session: \`${value.sessionId}\`\n`,
  ];
  if (value.development) paragraphs.push(renderDevelopmentEvidence(value.development));
  if (value.hasPatch && !value.development) paragraphs.push('A proposed patch is available in the worker. Human review is still required; this note does not mean files were changed or tests passed.\n');
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
          records = new Map                               ();
          lastSyncedAt                = null;
          error                = null;
          working = false;
          waiters                                                = [];
          closed = false;
          closing                                 ;
          documents                          ;
          snapshot                              ;
  constructor(documents                          , snapshot                              ) { this.documents = documents; this.snapshot = snapshot; }
  status()                        { return { directory: this.documents.directory, lastSyncedAt: this.lastSyncedAt, error: this.error, records: [...this.records.values()].map(record => ({ ...record })) }; }
  record(sessionId        )                                    { const value = this.records.get(sessionId); return value && { ...value }; }
  init() { return this.sync(); }
  sync()                                 {
    if (this.closed) return Promise.resolve(this.status());
    const result = new Promise                       (resolve => this.waiters.push(resolve));
    if (!this.working) void this.pump();
    return result;
  }
          async pump() {
    this.working = true;
    try {
      while (this.waiters.length) {
        const waiters = this.waiters.splice(0);
        const errors           = [];
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
  async get(sessionId        ) {
    if (!this.records.has(sessionId)) throw new DomainError('not_found', 'No saved feature-request note is available for this task. Refresh to retry tracking.');
    return this.documents.read(sessionId);
  }
  close()                                 { return this.closing ??= this.sync().then(status => { this.closed = true; return status; }); }
}
