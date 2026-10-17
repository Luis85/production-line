import { DomainError } from '../../shared/errors.js';
import type { InteractionCommand, InteractionView } from './interactions.js';
import type { FeatureRecord, FeatureQueuePort } from './feature-requests.js';
import { createTaskNoteIdentity, renderTaskNote, readTaskNote, taskNoteResponse, markTaskNoteResponse, type TaskNoteIdentity } from './task-notes.js';

export interface FeatureTaskProjection {
  identity: TaskNoteIdentity;
  link: string;
  submission?: {
    command: InteractionCommand;
    responseDigest: string;
    revision: string;
    outcome?: 'processed' | 'error';
    error?: string;
    acknowledged?: boolean;
  };
}
export interface FeatureTaskDocument { markdown: string; revision: string; }
export interface FeatureTaskNotesPort {
  ensure(note: FeatureTaskProjection, markdown: string, legacy?: { record: FeatureRecord; view: InteractionView }): Promise<void>;
  read(note: FeatureTaskProjection): Promise<FeatureTaskDocument | undefined>;
  write(note: FeatureTaskProjection, previous: FeatureTaskDocument, markdown: string): Promise<boolean>;
  attention(record: FeatureRecord, execution: NonNullable<ReturnType<FeatureQueuePort['inspect']>>): Promise<string | undefined>;
}
export function featureTaskLink(identity: TaskNoteIdentity) {
  return identity.action === 'answer'
    ? `_questions/${identity.featureId}/${identity.pendingId}.md`
    : `_tasks/${identity.featureId}/${identity.id}.md`;
}

/** Only the durable interaction journal can admit a reply; notes never change approved input. */
export class FeatureTaskNotes {
  private observed = new Map<string, string>();
  private port: FeatureTaskNotesPort;
  private queue: FeatureQueuePort;
  constructor(port: FeatureTaskNotesPort, queue: FeatureQueuePort) { this.port = port; this.queue = queue; }

  async consume(record: FeatureRecord, persist: () => Promise<void>): Promise<string | undefined> {
    const note = record.taskNote;
    if (!note || !this.queue.interact) return;
    const document = await this.port.read(note);
    if (!document) return;
    if (!note.submission || note.submission.outcome === 'error') {
      const previous = this.observed.get(note.identity.id);
      this.observed.set(note.identity.id, document.revision);
      if (previous !== document.revision) return;
      const response = taskNoteResponse(document.markdown, note.identity);
      if (!response) return;
      // A rejected reply must be explicitly edited before it is reconsidered.
      if (note.submission?.revision === document.revision) return;
      note.submission = { command: response.command, responseDigest: response.responseDigest, revision: document.revision };
    }
    const submission = note.submission;
    // Reservation and its exact operation ID survive an interrupted acknowledgement.
    await persist();
    if (!submission.outcome) {
      try {
        await this.queue.interact(record, submission.command);
        submission.outcome = 'processed';
        delete submission.error;
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 500) : 'Reply could not be accepted.';
        if (!(error instanceof DomainError) || error.code === 'unavailable') return message;
        submission.outcome = 'error';
        submission.error = message;
      }
      await persist();
    }
    // Preserve every operator byte in the body and refuse to overwrite a newer editor save.
    const answer = readTaskNote(document.markdown, note.identity).answer;
    const changedAfterAcceptance = answer !== (submission.command.answer ?? submission.command.message);
    const markdown = markTaskNoteResponse(document.markdown, note.identity, {
      status: changedAfterAcceptance ? 'error' : submission.outcome,
      ...(changedAfterAcceptance ? {} : { responseDigest: submission.responseDigest }),
      ...(changedAfterAcceptance ? { error: 'This checkpoint already accepted an earlier answer. Your edit is retained but does not start another execution.' } : submission.error ? { error: submission.error } : {}),
    });
    submission.acknowledged = await this.port.write(note, document, markdown);
    await persist();
    return submission.error;
  }

  async project(record: FeatureRecord, current: NonNullable<ReturnType<FeatureQueuePort['inspect']>>, owner: string, persist: () => Promise<void>) {
    if (record.taskNote?.submission && (!record.taskNote.submission.outcome || !record.taskNote.submission.acknowledged)) return;
    const identity = current.interaction && createTaskNoteIdentity(record.id, owner, current.interaction);
    if (!identity) {
      const attention = await this.port.attention(record, current);
      if (attention) record.attention = attention; else delete record.attention;
      return;
    }
    delete record.attention;
    if (record.taskNote?.identity.id !== identity.id) {
      record.taskNote = { identity, link: featureTaskLink(identity) };
    }
    await persist();
    const pending = current.interaction!.pending;
    await this.port.ensure(record.taskNote, renderTaskNote({
      identity,
      title: record.input?.title ?? record.name,
      question: pending?.message ?? current.error ?? 'The previous attempt stopped. Explain how the worker should continue with its saved approved input.',
      ...(pending?.choices ? { choices: pending.choices } : {}),
      ...(pending?.reason ? { reason: pending.reason } : {}),
    }), pending ? { record, view: current.interaction! } : undefined);
  }
}


export function validateFeatureTaskProjection(record: FeatureRecord, owner: string) {
  if (record.attention !== undefined && record.attention !== `_tasks/${record.id}/attention.md`) throw Error('Invalid feature attention note path.');
  const note = record.taskNote;
  if (!note) return;
  const identity = note.identity;
  if (!identity || identity.featureId !== record.id || identity.sessionId !== record.sessionId || identity.owner !== owner || note.link !== featureTaskLink(identity))
    throw Error('Invalid feature Task note binding.');
  const submission = note.submission;
  const markdown = renderTaskNote({ identity, title: 'Validate saved Task', question: 'Saved checkpoint',
    ...(submission ? { status: 'ready', answer: submission.command?.answer ?? submission.command?.message } : {}) });
  if (!submission) return;
  const response = taskNoteResponse(markdown, identity);
  if (!response || response.responseDigest !== submission.responseDigest ||
    JSON.stringify(response.command) !== JSON.stringify(submission.command) || !/^[a-f0-9]{64}$/.test(submission.revision) ||
    (submission.outcome !== undefined && !['processed', 'error'].includes(submission.outcome)) ||
    (submission.error !== undefined && (typeof submission.error !== 'string' || submission.error.length > 500)) ||
    (submission.acknowledged !== undefined && typeof submission.acknowledged !== 'boolean'))
    throw Error('Invalid feature Task response reservation.');
}
