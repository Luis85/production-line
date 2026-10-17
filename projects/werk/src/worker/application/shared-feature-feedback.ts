import { sharedFeatureRequestReference } from './feature-request-reference.js';
import { DomainError } from '../../shared/errors.js';
import { featureTaskDirectory } from './feature-workflow.js';
import { createTaskNoteIdentity, markTaskNoteResponse, readTaskNote, renderTaskNote, taskNoteResponse } from './task-notes.js';
import { sharedHash } from './shared-feature-notes.js';
import type { LifecycleWrite, SharedExecution, SharedFeatureRecord, SharedIntakePorts, SharedRepositoryPort } from './shared-feature-state.js';

type Artifact = LifecycleWrite['artifacts'][number];
const message = (error: unknown) => error instanceof Error ? error.message.slice(0, 500) : 'The Task response could not be accepted. Retry after restoring the worker connection.';

/** The response reservation survives dispatch acknowledgement loss; interaction admission deduplicates it. */
export class SharedFeatureFeedback {
  private ports: SharedIntakePorts;
  private save: () => Promise<void>;
  constructor(ports: SharedIntakePorts, save: () => Promise<void>) { this.ports = ports; this.save = save; }
  async synchronize(record: SharedFeatureRecord, repository: SharedRepositoryPort, execution: SharedExecution, signal: AbortSignal): Promise<{ artifacts: Artifact[]; error?: string }> {
    let error: string | undefined;
    if (record.task?.revision && !record.task.closed) {
      error = await this.respond(record, repository, signal);
      const artifact = this.artifact(record);
      if (artifact || error && record.task.response?.status === 'pending') return { artifacts: artifact ? [artifact] : [], ...(error ? { error } : {}) };
    }
    const current = this.ports.inspect(record.taskId!) ?? execution;
    const identity = current.interaction && createTaskNoteIdentity(record.id, record.owner!, current.interaction, sharedFeatureRequestReference(record).key, record.task?.identity);
    if (identity && identity.id !== record.task?.identity.id) {
      const pending = current.interaction!.pending;
      const markdown = renderTaskNote({ identity, title: record.title, question: pending?.message ?? 'The previous attempt stopped. Describe how the worker should continue.', choices: pending?.choices, reason: pending?.reason ?? current.error ?? undefined });
      record.task = { identity, path: featureTaskDirectory(record.workflow.configuration) + '/' + identity.id + '.md', markdown, revision: null };
      record.taskNote = record.task.path;
      error = undefined;
      await this.save();
    } else if (!identity && current.interaction && !record.task?.closed && record.task && record.task.response?.status !== 'pending' && ['queued', 'running', 'completed', 'cancelled'].includes(current.interaction.phase)) {
      if (record.task.response?.status !== 'processed' && !error) record.task.markdown = markTaskNoteResponse(record.task.markdown, record.task.identity, { status: 'error', error: 'This checkpoint was continued or closed through another worker interface. Follow the latest feature request and Task note.' });
      record.task.closed = true;
      if (record.taskNote === record.task.path) record.taskNote = null;
      await this.save();
    }
    const artifact = this.artifact(record);
    return { artifacts: artifact ? [artifact] : [], ...(error ? { error } : {}) };
  }
  private artifact(record: SharedFeatureRecord): Artifact | undefined {
    const task = record.task;
    if (task && sharedHash(task.markdown) !== task.revision) return { path: task.path, expectedRevision: task.revision, content: task.markdown };
  }
  private async respond(record: SharedFeatureRecord, repository: SharedRepositoryPort, signal: AbortSignal): Promise<string | undefined> {
    const task = record.task!;
    const head = await repository.head(signal), current = await repository.readBlob(head, task.path, signal);
    if (current === null) return 'The published Task note is missing. Restore it from Git history to continue.';
    let note;
    try { note = readTaskNote(current, task.identity); }
    catch (error) { return message(error); }
    // A completed admission remains authoritative even if the human edits the note while acknowledgement is in flight.
    if (task.response?.status === 'processed') {
      if (current === task.markdown && sharedHash(current) === task.revision) return;
      task.revision = sharedHash(current);
      task.markdown = this.acknowledge(current, task.identity, task.response.digest);
      await this.save();
      return;
    }
    if (task.response?.status === 'error' && sharedHash(current) !== task.revision && note.status === 'ready') delete task.response;
    if (task.response?.status === 'error') return task.response.error;
    if (!task.response) {
      let response;
      try { response = taskNoteResponse(current, task.identity); }
      catch (error) {
        task.revision = sharedHash(current);
        task.markdown = markTaskNoteResponse(current, task.identity, { status: 'error', error: message(error) });
        await this.save();
        return message(error);
      }
      if (!response) { task.revision = sharedHash(current); task.markdown = current; return; }
      task.response = { command: response.command, digest: response.responseDigest, markdown: current, revision: sharedHash(current), status: 'pending' };
      await this.save();
    }
    const response = task.response;
    const source = await repository.readBlob(head, record.sourcePath, signal);
    if (source === null || sharedHash(source) !== record.remoteRevision) return 'The claimed feature request changed before continuation. Restore its accepted content or create a successor request; this answer has not started another attempt.';
    if (!this.ports.continue) return 'This worker cannot accept Markdown Task responses. Update the worker to continue.';
    // A prior failed save may have left this reservation only in memory. Persist before every dispatch attempt.
    await this.save();
    try {
      await this.ports.continue(record, response.command);
      response.status = 'processed';
      delete response.error;
      await this.save();
      task.revision = sharedHash(current);
      task.markdown = this.acknowledge(current, task.identity, response.digest);
      await this.save();
    } catch (error) {
      const reason = message(error);
      if (!(error instanceof DomainError) || !['invalid_input', 'conflict', 'not_found'].includes(error.code)) {
        // Unavailable and unknown outcomes stay reserved. A retry uses the exact operation, never a fresh paid turn.
        response.error = reason;
        await this.save();
        return reason;
      }
      response.status = 'error'; response.error = reason;
      task.revision = sharedHash(current);
      task.markdown = markTaskNoteResponse(current, task.identity, { status: 'error', error: reason });
      await this.save();
      return reason;
    }
  }
  private acknowledge(markdown: string, identity: NonNullable<SharedFeatureRecord['task']>['identity'], digest: string) {
    try { return markTaskNoteResponse(markdown, identity, { status: 'processed', responseDigest: digest }); }
    catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'conflict') throw error;
      return markTaskNoteResponse(markdown, identity, { status: 'error', error: 'A previous answer was already accepted. This later edit was preserved but was not dispatched. Use the latest Task note for any further response.' });
    }
  }
  /** Rebase only a Task acknowledgement after a teammate edit; never rebase accepted FR content. */
  async refreshAcknowledgement(record: SharedFeatureRecord, repository: SharedRepositoryPort, signal: AbortSignal) {
    const task = record.task, pending = record.pending;
    if (!task?.response || task.response.status !== 'processed' || !pending) return;
    const artifact = pending.artifacts.find(item => item.path === task.path);
    if (!artifact) return;
    const head = await repository.head(signal), current = await repository.readBlob(head, task.path, signal);
    if (current === null || sharedHash(current) === artifact.expectedRevision || current === artifact.content) return;
    readTaskNote(current, task.identity);
    task.revision = sharedHash(current); task.markdown = this.acknowledge(current, task.identity, task.response.digest);
    artifact.expectedRevision = task.revision; artifact.content = task.markdown;
    pending.operationId = 'lifecycle-' + sharedHash(record.id + pending.request.content + JSON.stringify(pending.artifacts));
    await this.save();
  }
}
