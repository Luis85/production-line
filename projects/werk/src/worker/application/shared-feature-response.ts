import { DomainError } from '../../shared/errors.js';
import { canonicalJson } from './request-gates.js';
import type { InteractionCommand } from './interactions.js';
import type { SharedFeatureRecord, SharedRepositoryPort } from './shared-feature-state.js';
import { sharedHash } from './shared-feature-notes.js';
import { readTaskNote, writeTaskNoteAnswer } from './task-notes.js';

type Artifact = { path: string; expectedRevision: string; content: string };
function conflict(message: string): never { throw new DomainError('conflict', message); }
const input = (command: InteractionCommand) => (command.action === 'answer' ? command.answer : command.message ?? 'Resume the saved approved-file task context.')?.replace(/\r\n?/g, '\n').trim();

/** The webview edits the same checkpoint note; only committed Markdown feedback dispatches work. */
export async function publishSharedFeatureResponse(options: {
  record: SharedFeatureRecord; command: InteractionCommand; repository: SharedRepositoryPort;
  publish(artifacts: Artifact[]): Promise<void>; signal: AbortSignal;
}) {
  const { record, command, repository, publish, signal } = options;
  const task = record.task;
  if (!task?.revision) conflict('The shared Feature Request has no published response checkpoint. Refresh its Task note before answering.');
  const identity = task.identity, answer = input(command);
  if (!answer || answer.length > 8000) throw new DomainError('invalid_input', 'Provide a nonempty Task response of at most 8,000 characters.');
  if (command.sessionId !== identity.sessionId || command.action !== identity.action || command.expectedRevision !== identity.expectedRevision ||
    (identity.action === 'answer' ? command.pendingId !== identity.pendingId : command.turnId !== identity.turnId))
    conflict('This shared Feature Request checkpoint changed. Refresh its current Task before answering.');
  const normalized: InteractionCommand = { action: command.action, sessionId: command.sessionId, expectedRevision: command.expectedRevision, operationId: command.operationId,
    ...(command.action === 'answer' ? { pendingId: command.pendingId, answer } : { turnId: command.turnId, message: answer }) };
  const previous = task.uiResponse;
  if (previous && canonicalJson(previous.command) !== canonicalJson(normalized) &&
      (previous.command.operationId === command.operationId || task.response?.status !== 'error'))
    conflict('A different response is already saved for this checkpoint. Refresh the Feature Request before responding again.');
  if (task.response && task.response.status !== 'error') {
    if (input(task.response.command) !== answer) conflict('This Task already has a different published answer. Follow the latest Feature Request checkpoint.');
    return;
  }
  if (task.closed) conflict('This Task checkpoint is closed. Follow the latest Feature Request before continuing.');
  if (record.pending) throw new DomainError('unavailable', record.error ?? 'The previous Feature Request publication is pending. Retry after Git synchronization succeeds.');
  const head = await repository.head(signal);
  const source = await repository.readBlob(head, record.sourcePath, signal);
  if (source === null || sharedHash(source) !== record.remoteRevision)
    conflict('The claimed Feature Request changed before continuation. Restore its accepted content or create a successor request.');
  const current = await repository.readBlob(head, task.path, signal);
  if (current === null) conflict('The published Task note is missing. Restore it from Git history before answering.');
  const note = readTaskNote(current, identity);
  if (note.status === 'processed') conflict('This Task is already marked processed. Refresh its current Feature Request before answering.');
  if (note.status === 'ready') {
    if (note.answer !== answer) conflict('A teammate already published a different Task answer. Refresh the Feature Request before responding.');
    return;
  }
  if (note.status !== 'error' && note.answer.replace(/<!--[\s\S]*?(?:-->|$)/g, '').trim() && note.answer !== answer)
    conflict('A teammate changed this Task answer. Refresh the note and preserve their response.');
  const markdown = writeTaskNoteAnswer(current, identity, answer);
  task.revision = sharedHash(current);
  task.markdown = markdown;
  task.uiResponse = { command: normalized, markdown };
  await publish([{ path: task.path, expectedRevision: task.revision, content: markdown }]);
}

/** A definite compare-and-swap rejection can yield to a teammate answer; unknown push outcomes cannot. */
export async function recoverSharedFeatureResponseConflict(record: SharedFeatureRecord, repository: SharedRepositoryPort, signal: AbortSignal): Promise<boolean> {
  const task = record.task, pending = record.pending;
  if (!task?.uiResponse || !pending || task.response && task.response.status !== 'error' || pending.artifacts.length !== 1 ||
      sharedHash(pending.request.content) !== record.remoteRevision) return false;
  const artifact = pending.artifacts[0]!;
  if (artifact.path !== task.path || artifact.content !== task.uiResponse.markdown) return false;
  const head = await repository.head(signal);
  const source = await repository.readBlob(head, record.sourcePath, signal);
  if (source === null || sharedHash(source) !== record.remoteRevision) return false;
  const current = await repository.readBlob(head, task.path, signal);
  if (current === null || current === artifact.content || sharedHash(current) === artifact.expectedRevision) return false;
  readTaskNote(current, task.identity);
  // The immutable Git receipt was absent at the definitive rejection. Preserve the remote edit,
  // release only this unconfirmed Task write, then let the normal Markdown consumer validate it.
  task.markdown = current;
  task.revision = sharedHash(current);
  delete task.uiResponse;
  delete task.response;
  delete record.pending;
  record.publication = 'synced';
  record.error = null;
  return true;
}
