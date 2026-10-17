import { createTaskNoteIdentity } from './task-notes.js';
import { SharedFeatureFeedback } from './shared-feature-feedback.js';
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
  constructor(ports: SharedIntakePorts, save: () => Promise<void>) { this.ports = ports; this.save = save; this.feedback = new SharedFeatureFeedback(ports, save); }
  private async flush(record: SharedFeatureRecord, repository: SharedRepositoryPort, signal: AbortSignal) {
    if (!record.pending) return;
    const write = record.pending;
    try { await repository.publishLifecycle(write, signal); }
    catch (error) {
      const operation = write.operationId;
      await this.feedback.refreshAcknowledgement(record, repository, signal);
      if (operation === write.operationId) throw error;
      await repository.publishLifecycle(write, signal);
    }
    record.remoteRevision = sharedHash(write.request.content);
    record.claimed = true;
    record.publication = 'synced';
    record.publishedState = sharedHash(write.request.content);
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
    if (sharedTaskActive(record) || !sharedTerminal(record.status) || record.publication !== 'synced' || record.pending) return false;
    const execution = this.ports.inspect(record.taskId!);
    // Confirmed terminal publications survive removed assignments or archived local
    // history. A resumed task still has to publish its new lifecycle and evidence.
    if (!execution) return true;
    const actionable = execution.interaction && createTaskNoteIdentity(record.id, record.owner!, execution.interaction);
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
      if (!record.submitted) {
        if (!this.ports.canAdmit()) return;
        const head = await repository.head(signal);
        const current = await repository.readBlob(head, record.sourcePath, signal);
        if (current === null || sharedHash(current) !== record.remoteRevision) throw Error('The remotely claimed request changed before admission. Restore its claimed content or resolve the change before execution.');
        await this.ports.submit(record);
        record.submitted = true;
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
