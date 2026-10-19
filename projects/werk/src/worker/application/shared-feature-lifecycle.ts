import { SharedReadyReviewLifecycle } from './shared-ready-review.js';
import { sharedFeatureRequestReference } from './feature-request-reference.js';
import { createTaskNoteIdentity } from './task-notes.js';
import { SharedFeatureFeedback } from './shared-feature-feedback.js';
import { recoverSharedFeatureResponseConflict } from './shared-feature-response.js';
import { DomainError } from '../../shared/errors.js';
import { featureTaskDirectory } from './feature-workflow.js';
import { sharedTaskActive, sharedTerminal, type SharedExecution, type SharedFeatureRecord, type SharedIntakePorts, type SharedRepositoryPort } from './shared-feature-state.js';
import { doneEvidence, renderSharedBlocker, renderSharedReview, sharedHash, sharedFeaturePublicationDigest } from './shared-feature-notes.js';

function executionStatus(execution: SharedExecution) {
  if (execution.interaction && ['waiting_input', 'escalated', 'failed', 'interrupted'].includes(execution.interaction.phase)) return execution.interaction.phase;
  const status = execution.request?.phase === 'readiness' ? 'needs_rework' : execution.request?.phase ?? execution.status;
  return status === 'review' || status === 'done' ? 'checking' : status;
}

/** A persisted outbox separates local execution from remotely confirmed lifecycle changes. */
export class SharedFeatureLifecycle {
  private ports: SharedIntakePorts;
  private save: () => Promise<void>;
  private feedback: SharedFeatureFeedback;
  private readiness: SharedReadyReviewLifecycle;
  constructor(ports: SharedIntakePorts, save: () => Promise<void>) { this.ports = ports; this.save = save; this.feedback = new SharedFeatureFeedback(ports, save); this.readiness = new SharedReadyReviewLifecycle(ports, save, (record, repository, signal) => this.publish(record, repository, signal)); }
  /** A receipt confirms only the exact source and artifacts it published, never later local changes. */
  publication(record: SharedFeatureRecord): SharedFeatureRecord['publication'] {
    if (record.publication === 'error') return 'error';
    if (record.pending || !record.claimed || record.remoteRevision !== record.publishedState
      || sharedHash(this.ports.renderSource(record)) !== record.publishedState) return 'pending';
    if (record.status === 'ready_for_review' && (!record.featureCommit || !record.featureBranch || !record.outputDigest || !record.reviewNote)) return 'pending';
    if (record.reviewNote && (!record.reviewMarkdown || record.publishedReview !== record.reviewNote + ':' + sharedHash(record.reviewMarkdown))) return 'pending';
    if (record.task && sharedHash(record.task.markdown) !== record.task.revision) return 'pending';
    if (record.diagnostic && record.taskNote === record.diagnostic.path && record.diagnostic.published !== sharedHash(record.diagnostic.markdown)) return 'pending';
    return 'synced';
  }
  private async flush(record: SharedFeatureRecord, repository: SharedRepositoryPort, signal: AbortSignal) {
    if (!record.pending) return;
    const write = record.pending;
    try { await repository.publishLifecycle(write, signal); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'conflict' && record.claimed && record.readyReviewState && !record.submitted && !write.artifacts.length && this.ports.readyReviewResponse) {
        const current = await repository.readBlob(await repository.head(signal), record.sourcePath, signal);
        if (current !== null) {
          // A definite CAS conflict is not an unknown acknowledgment. Preserve the pushed edit and re-read it through the owned FR phase.
          this.ports.readyReviewResponse(current, record);
          delete record.pending; delete record.readyReviewState.implementationReady;
          record.publication = 'pending'; await this.save(); return;
        }
      }
      if (error && typeof error === 'object' && 'code' in error && error.code === 'conflict' &&
          await recoverSharedFeatureResponseConflict(record, repository, signal)) {
        await this.save();
        throw new DomainError('conflict', 'A teammate changed the Task before this response was published. Their note was preserved; refresh the Feature Request before responding again.');
      }
      const operation = write.operationId;
      await this.feedback.refreshAcknowledgement(record, repository, signal);
      if (operation === write.operationId) throw error;
      await repository.publishLifecycle(write, signal);
    }
    record.remoteRevision = sharedHash(write.request.content);
    record.claimed = true;
    record.publication = 'synced';
    record.publishedState = sharedHash(write.request.content);
    record.publishedSource = write.request.content;
    for (const artifact of write.artifacts) {
      if (artifact.path === record.reviewNote) record.publishedReview = artifact.path + ':' + sharedHash(artifact.content);
      if (artifact.path === record.task?.path) record.task.revision = sharedHash(artifact.content);
      if (artifact.path === record.diagnostic?.path) record.diagnostic.published = sharedHash(artifact.content);
    }
    delete record.pending;
    await this.save();
  }
  async publish(record: SharedFeatureRecord, repository: SharedRepositoryPort, signal: AbortSignal, artifacts: { path: string; content: string; expectedRevision?: string | null }[] = []) {
    await this.flush(record, repository, signal);
    const content = this.ports.renderSource(record);
    if (Buffer.byteLength(content) > 65536) throw new DomainError('invalid_input', 'The Feature Request progress note exceeds 64 KiB. Shorten its original details before publication can continue.');
    if (sharedHash(content) === record.publishedState && !artifacts.length) return;
    record.pending = {
      operationId: 'lifecycle-' + sharedHash(record.id + content + JSON.stringify(artifacts)),
      request: { path: record.sourcePath, expectedRevision: record.remoteRevision, content },
      artifacts: artifacts.map(a => ({ ...a, expectedRevision: a.expectedRevision ?? null })),
    };
    record.publication = 'pending';
    await this.save();
    await this.flush(record, repository, signal);
  }
  private change(record: SharedFeatureRecord, status: string, error: string | null = null) {
    if (record.status !== status || record.error !== error) { record.status = status; record.error = error; record.updatedAt = new Date().toISOString(); }
  }
  private settled(record: SharedFeatureRecord) {
    if (sharedTaskActive(record) || !sharedTerminal(record.status) || this.publication(record) !== 'synced') return false;
    const execution = this.ports.inspect(record.taskId!);
    // Confirmed terminal publications survive removed assignments or archived local
    // history. A resumed task still has to publish its new lifecycle and evidence.
    if (!execution) return true;
    const actionable = execution.interaction && createTaskNoteIdentity(record.id, record.owner!, execution.interaction, sharedFeatureRequestReference(record).key, record.task?.identity);
    if (actionable && actionable.id !== record.task?.identity.id) return false;
    if (record.status === 'ready_for_review') return !!record.featureCommit && !!doneEvidence(record, execution) && record.outputDigest === execution.request?.execution?.outputDigest;
    return executionStatus(execution) === record.status && (execution.error ?? null) === record.error;
  }
  async reconcile(record: SharedFeatureRecord, signal: AbortSignal) {
    try {
      if (this.settled(record)) return;
      const repository = this.ports.repository(record.binding, record.workflow);
      await this.flush(record, repository, signal);
      if (!record.claimed) await this.publish(record, repository, signal);
      if (!await this.readiness.reconcile(record, repository, signal)) return;
      if (!record.submitted) {
        const hold = this.ports.admissionHold?.();
        if (hold && !this.ports.inspect(record.taskId!)) {
          await this.admissionDiagnostic(record, repository, signal, hold.message, true);
          return;
        }
        if (!this.ports.canAdmit()) return;
        const head = await repository.head(signal);
        const current = await repository.readBlob(head, record.sourcePath, signal);
        if (current === null || sharedHash(current) !== record.remoteRevision) throw Error('The remotely claimed request changed before admission. Restore its claimed content or resolve the change before execution.');
        try { await this.ports.submit(record); }
        catch (error) {
          signal.throwIfAborted();
          // A lost acknowledgement may already own an execution. Replay its exact
          // submission on the next sync rather than publishing a false failure.
          if (this.ports.inspect(record.taskId!)) throw error;
          const hold = this.ports.admissionHold?.();
          const reason = hold?.message ?? (error instanceof Error ? error.message.slice(0, 500) : 'Request preparation could not be confirmed.');
          await this.admissionDiagnostic(record, repository, signal, reason, !!hold);
          return;
        }
        record.submitted = true;
        if (!record.task && record.diagnostic && record.taskNote === record.diagnostic.path) record.taskNote = null;
        this.change(record, 'queued');
        await this.save();
      }
      const execution = this.ports.inspect(record.taskId!);
      if (!execution) { this.change(record, 'blocked', 'The claimed task history is unavailable. The worker will not execute it again automatically.'); record.progress = record.error!; const artifacts = this.blocker(record, record.error!); await this.save(); await this.publish(record, repository, signal, artifacts); return; }
      await this.progress(record, repository, execution, signal);
    } catch (error) {
      if (signal.aborted) return;
      record.publication = 'error';
      record.error = error instanceof Error ? error.message.slice(0, 500) : 'Shared progress could not be published.';
      await this.save();
    }
  }
  private async admissionDiagnostic(record: SharedFeatureRecord, repository: SharedRepositoryPort, signal: AbortSignal, reason: string, held: boolean) {
    this.change(record, held ? 'queued' : 'blocked', reason);
    record.progress = (held ? 'Request admission is waiting.' : 'Request preparation needs attention.')
      + ' Follow the diagnostic Task; the worker will retry admission using this same request identity.';
    const artifacts = this.blocker(record, reason);
    const guarded = [];
    const head = artifacts.length ? await repository.head(signal) : null;
    for (const artifact of artifacts) {
      const existing = await repository.readBlob(head!, artifact.path, signal);
      if (existing !== null && existing !== artifact.content) throw new DomainError('conflict', 'A teammate changed the admission diagnostic. Their note was preserved; restore its worker-generated content before synchronization.');
      // A recurring hold may reuse an older immutable note. Guard the exact content
      // instead of treating its deterministic path as a new file.
      guarded.push({ ...artifact, expectedRevision: existing === null ? null : sharedHash(existing) });
    }
    await this.save();
    // Compare the claimed source and retain publication receipts when an acknowledgement
    // is lost. A concurrent teammate edit must never be replaced by this notice.
    await this.publish(record, repository, signal, guarded);
  }
  private blocker(record: SharedFeatureRecord, reason: string) {
    const markdown = renderSharedBlocker(record, reason), digest = sharedHash(markdown);
    if (record.diagnostic?.markdown !== markdown) record.diagnostic = { path: featureTaskDirectory(record.workflow.configuration) + '/blocked-' + sharedHash(record.taskId! + digest).slice(0, 40) + '.md', markdown };
    record.taskNote = record.diagnostic.path;
    return record.diagnostic.published === digest ? [] : [{ path: record.diagnostic.path, expectedRevision: null, content: markdown }];
  }
  private async progress(record: SharedFeatureRecord, repository: SharedRepositoryPort, execution: SharedExecution, signal: AbortSignal) {
    const feedback = await this.feedback.synchronize(record, repository, execution, signal);
    execution = this.ports.inspect(record.taskId!) ?? execution;
    const request = execution.request;
    const evaluation = doneEvidence(record, execution);
    if (evaluation) {
      const outputDigest = request!.execution!.outputDigest!, publicationDigest = sharedFeaturePublicationDigest(record, outputDigest);
      if (record.outputDigest !== outputDigest || !record.featureCommit) {
        this.change(record, 'publishing');
        record.done = { passed: true, issues: [] };
        await this.save();
        const result = await repository.publishPatch({ operationId: 'feature-' + publicationDigest, featureId: record.id, sourceCommit: record.sourceCommit, patch: execution.patch!, approvedPaths: record.accepted.paths! }, signal);
        record.featureBranch = result.branch;
        record.featureCommit = result.commit;
        record.outputDigest = outputDigest;
        record.reviewNote = record.workflow.configuration.reviewDirectory + '/' + record.id + '-' + publicationDigest.slice(0, 12) + '.md';
        this.change(record, 'ready_for_review');
        record.reviewMarkdown = renderSharedReview(record, execution, evaluation);
        await this.save();
      } else this.change(record, 'ready_for_review');
      record.progress = 'Implementation and completion checks passed. Review the published feature branch using the PullRequest note.';
      await this.save();
      await this.publish(record, repository, signal, [...feedback.artifacts, ...(record.publishedReview === record.reviewNote + ':' + sharedHash(record.reviewMarkdown!) ? [] : [{ path: record.reviewNote!, content: record.reviewMarkdown! }])]);
      return;
    }
    const done = request?.evaluations.filter(e => e.stage === 'done' && e.inputRevision === request.inputRevision && e.outputDigest === request.execution?.outputDigest).at(-1);
    record.done = done ? { passed: false, issues: done.rules.filter(rule => rule.result !== 'pass').map(rule => `${rule.ruleId}: ${rule.result === 'unknown' ? 'verified evidence is unavailable' : 'completion check failed'}`) } : null;
    this.change(record, executionStatus(execution), feedback.error ?? execution.error ?? null);
    const reason = feedback.error ?? record.error ?? (record.done?.issues.length ? record.done.issues.join('; ') : null);
    record.progress = (reason ? `Worker status: ${record.status.replaceAll('_', ' ')}. ${reason}` : record.taskNote && ['waiting_input', 'escalated', 'failed', 'interrupted'].includes(record.status) ? 'The worker needs your input. Open the Task note, write an answer, set status to ready, then commit and push.' : `Worker status: ${record.status.replaceAll('_', ' ')}. Progress is saved in this request; the worker will publish a PullRequest note when checks pass.`).slice(0, 2000);
    const artifacts = [...feedback.artifacts];
    if (!record.task || record.task.response?.status === 'processed') {
      if (['blocked', 'needs_rework', 'failed', 'interrupted', 'escalated', 'waiting_input'].includes(record.status) || record.done?.issues.length) artifacts.push(...this.blocker(record, reason ?? 'The worker cannot continue automatically. Inspect the current execution and configuration.'));
    }
    await this.save();
    await this.publish(record, repository, signal, artifacts);
  }
}
