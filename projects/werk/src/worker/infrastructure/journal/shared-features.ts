import { validateFeatureIntakeMeasurements } from '../../application/feature-intake-measurement.js';
import { validateFeaturePreparation } from '../../application/feature-preparation.js';
import { sharedFeatureInputHash, assertSharedFeatureSelection } from '../../application/shared-feature-selection.js';
import { validateFeatureReviewEligibility } from '../features/review-eligibility.js';
import { validateReadyReviewInput, readyReviewSessionId } from '../../application/ready-review-contracts.js';
import { parseReadyReviewResult } from '../../application/ready-review-protocol.js';
import { sharedReviewInput } from '../../application/shared-ready-review.js';
import { readyReviewCandidate } from '../../application/ready-review-notes.js';
import { SerializedOperations } from '../../../shared/serialized-operations.js';
import { acceptedSharedBody } from '../features/shared-progress.js';
import { readTaskNote, taskNoteResponse } from '../../application/task-notes.js';
import { parseFeature } from '../features/document.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { atomicWrite, readBoundedFile } from './files.js';
import { defaultSharedIntakeConfig, validateSharedIntakeConfig, bindingKey, type SharedFeatureState } from '../../application/shared-feature-state.js';
import { sharedHash, sharedFeaturePublicationDigest } from '../../application/shared-feature-notes.js';
import { validateFeatureWorkflow, validateFeatureCheck, featureWorkflowPolicy, featureTaskDirectory, featureInputHash } from '../../application/feature-workflow.js';
import { identifier } from '../../../shared/validation.js';
import { gateDigest, canonicalJson } from '../../application/request-gates.js';
import { validateFeatureReadiness, assertFeatureWorkflowDefinitionPrompts } from '../features/workflow.js';

/** Private recovery journal. No claim is dispatched from an unvalidated or partially written record. */
export class SharedFeatureJournal {
  private path: string;
  private readonly writes = new SerializedOperations();
  constructor(directory: string) { this.path = join(directory, 'shared-intake.json'); }
  async load(): Promise<SharedFeatureState> {
    try {
      const state = JSON.parse(await readBoundedFile(this.path, 16777216)) as SharedFeatureState;
      if (state.schemaVersion !== 1 || !/^[a-zA-Z0-9_-]{1,100}$/.test(state.workerId) || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.records) || state.records.length > 100 || new Set(state.records.map(r => bindingKey(r.binding) + r.id)).size !== state.records.length) throw Error('Invalid shared intake journal.');
      validateSharedIntakeConfig(state.config); validateFeatureIntakeMeasurements(state.measurements);
      for (const record of state.records) {
        validateSharedIntakeConfig(record.binding);
        const snapshot = record.workflow;
        validateFeatureWorkflow(snapshot.configuration);
        assertFeatureWorkflowDefinitionPrompts(snapshot);
        validateFeatureCheck(snapshot.readyCheck, 'ready'); validateFeatureCheck(snapshot.doneCheck, 'done');
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.sourceCommit) || (!record.readyReviewState && snapshot.commit !== record.sourceCommit) || snapshot.policyDigest !== gateDigest(snapshot.policy) || snapshot.policyDigest !== gateDigest(featureWorkflowPolicy(snapshot.readyCheck, snapshot.doneCheck, snapshot.configuration.id)) || sharedHash(snapshot.template) !== snapshot.files.template.sha256) throw Error('Invalid frozen shared workflow.');
        const review = record.readyReviewState;
        if (!!snapshot.readyReview !== !!review) throw Error('Missing accepted Ready Check checkpoint.');
        const markdown = review ? readyReviewCandidate(record.sourceMarkdown, review.answer) : record.sourceMarkdown;
        const readiness = review && !review.implementationReady
          ? validateFeatureReviewEligibility(markdown, snapshot, record.accepted.provider)
          : validateFeatureReadiness(markdown, snapshot.readyCheck, record.accepted.provider, snapshot.template, { configuration: snapshot.configuration, workflowPath: snapshot.files.configuration.path, allowLegacyProgressMetadata: true });
        validateFeaturePreparation(record);
        assertSharedFeatureSelection(record);
        if (review) validateSharedReadyReview(record);
        if (!readiness.valid || !readiness.input || record.id !== readiness.input.id || canonicalJson({ ...record.accepted, providerExplicit: undefined }) !== canonicalJson({ ...readiness.input, providerExplicit: undefined }) || record.owner !== state.workerId || record.taskId !== 'shared-feature-' + sharedHash(record.id + bindingKey(record.binding)).slice(0, 32)) throw Error('Invalid accepted shared feature.');
        if (record.inputHash !== sharedFeatureInputHash(record) || typeof record.claimed !== 'boolean' || typeof record.submitted !== 'boolean' || record.submitted && !record.claimed || !/^[a-f0-9]{64}$/.test(record.remoteRevision)) throw Error('Invalid shared feature reservation.');
        if (record.sourcePath !== snapshot.configuration.requestsDirectory + '/' + record.name || !/^[^/\\]+\.md$/.test(record.name) || record.name.startsWith('_')) throw Error('Invalid shared feature source path.');
        if (record.publishedSource !== undefined && (typeof record.publishedSource !== 'string' || sharedHash(record.publishedSource) !== record.publishedState)) throw Error('Invalid acknowledged shared source.');
        if (record.featureCommit !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.featureCommit) || record.outputDigest !== undefined && !/^[a-f0-9]{64}$/.test(record.outputDigest) || record.publishedState !== undefined && !/^[a-f0-9]{64}$/.test(record.publishedState) || record.publishedReview !== undefined && (typeof record.publishedReview !== 'string' || !record.publishedReview.startsWith(snapshot.configuration.reviewDirectory + '/') || !/^[^:]+:[a-f0-9]{64}$/.test(record.publishedReview))) throw Error('Invalid shared publication checkpoint.');
        if (record.reviewNote !== null && (typeof record.outputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(record.outputDigest) || record.reviewNote !== snapshot.configuration.reviewDirectory + '/' + record.id + '-' + sharedFeaturePublicationDigest(record, record.outputDigest).slice(0, 12) + '.md' || typeof record.reviewMarkdown !== 'string' || Buffer.byteLength(record.reviewMarkdown) > 524288)) throw Error('Invalid shared review note.');
        const task = record.task, taskDirectory = featureTaskDirectory(snapshot.configuration);
        if (task) {
          if (!task.identity || task.identity.featureId !== record.id || task.identity.owner !== state.workerId || !/^task-[a-f0-9]{40}$/.test(task.identity.id) || task.path !== taskDirectory + '/' + task.identity.id + '.md' || typeof task.markdown !== 'string' || task.revision !== null && !/^[a-f0-9]{64}$/.test(task.revision) || task.closed !== undefined && typeof task.closed !== 'boolean') throw Error('Invalid shared Task checkpoint.');
          readTaskNote(task.markdown, task.identity);
          if (task.uiResponse) {
            const reply = task.uiResponse, expected = taskNoteResponse(reply.markdown, task.identity);
            identifier(reply.command.operationId, 'Task publication operation');
            if (!expected || canonicalJson({ ...expected.command, operationId: reply.command.operationId }) !== canonicalJson(reply.command)) throw Error('Invalid shared UI response reservation.');
          }
          if (task.response) {
            const response = task.response, expected = taskNoteResponse(response.markdown, task.identity);
            if (!expected || expected.responseDigest !== response.digest || JSON.stringify(expected.command) !== JSON.stringify(response.command) || response.revision !== sharedHash(response.markdown) || !['pending', 'processed', 'error'].includes(response.status) || response.error !== undefined && (typeof response.error !== 'string' || response.error.length > 500)) throw Error('Invalid shared Task response reservation.');
          }
        }
        if (record.diagnostic) {
          const diagnostic = record.diagnostic;
          if (typeof diagnostic.markdown !== 'string' || Buffer.byteLength(diagnostic.markdown) > 65536 || diagnostic.path !== taskDirectory + '/blocked-' + sharedHash(record.taskId! + sharedHash(diagnostic.markdown)).slice(0, 40) + '.md' || diagnostic.published !== undefined && diagnostic.published !== sharedHash(diagnostic.markdown)) throw Error('Invalid shared diagnostic checkpoint.');
          const note = parseFeature(diagnostic.markdown).data;
          if (note.type !== 'Task' || (note.status !== 'blocked' && note.status !== 'waiting') || note.featureId !== record.id || note.owner !== state.workerId || note.sourceCommit !== record.sourceCommit || note.inputHash !== record.inputHash) throw Error('Invalid shared diagnostic identity.');
        }
        if (record.taskNote != null && record.taskNote !== task?.path && record.taskNote !== record.diagnostic?.path || record.progress !== undefined && (typeof record.progress !== 'string' || record.progress.length > 2000)) throw Error('Invalid shared progress projection.');
        if (record.pending) {
          const pending = record.pending;
          if (pending.request.path !== record.sourcePath || pending.request.expectedRevision !== record.remoteRevision || !/^[a-zA-Z0-9_-]{1,100}$/.test(pending.operationId) || typeof pending.request.content !== 'string' || Buffer.byteLength(pending.request.content) > 65536 || !Array.isArray(pending.artifacts) || pending.artifacts.length > 3) throw Error('Invalid shared publication outbox.');
          const publication = parseFeature(pending.request.content), original = parseFeature(record.sourceMarkdown);
          const shared = (publication.data.werk as { shared?: { owner?: string; sourceCommit?: string; sourceHash?: string } })?.shared;
          if (publication.data.id !== record.id || acceptedSharedBody(publication) !== original.body || shared?.owner !== state.workerId || shared?.sourceCommit !== record.sourceCommit || shared?.sourceHash !== record.inputHash) throw Error('Invalid shared claim outbox.');
          if (new Set(pending.artifacts.map(artifact => artifact.path)).size !== pending.artifacts.length) throw Error('Duplicate shared artifact outbox.');
          for (const artifact of pending.artifacts) {
            if (!artifact || typeof artifact.content !== 'string' || Buffer.byteLength(artifact.content) > 524288) throw Error('Invalid shared artifact outbox.');
            const review = artifact.path === record.reviewNote && artifact.expectedRevision === null && artifact.content === record.reviewMarkdown;
            const action = task && artifact.path === task.path && artifact.expectedRevision === task.revision && artifact.content === task.markdown;
            const diagnostic = record.diagnostic && artifact.path === record.diagnostic.path && (artifact.expectedRevision === null || artifact.expectedRevision === sharedHash(record.diagnostic.markdown)) && artifact.content === record.diagnostic.markdown;
            if (!review && !action && !diagnostic) throw Error('Invalid shared artifact outbox.');
          }
        }
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const state: SharedFeatureState = { schemaVersion: 1, workerId: randomUUID(), revision: 0, config: defaultSharedIntakeConfig(), records: [] };
      await this.save(state); return state;
    }
  }
  save(state: SharedFeatureState) {
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text) > 16777216) return Promise.reject(Error('Shared intake journal exceeds 16 MiB.'));
    return this.writes.run(() => atomicWrite(this.path, text));
  }
}

function validateSharedReadyReview(record: import('../../application/shared-feature-state.js').SharedFeatureRecord) {
  const review = record.readyReviewState!;
  validateReadyReviewInput(review.input);
  if (!Number.isSafeInteger(review.generation) || review.generation < 1 || typeof review.answer !== 'string' || review.answer.length > 8000 || !['queued', 'running', 'waiting_input', 'passed', 'failed'].includes(review.status)
      || !Array.isArray(review.sessionIds) || review.sessionIds.length > 16 || !review.sessionIds.includes(readyReviewSessionId(review.input)) || review.sessionIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) throw Error('Invalid Ready Check checkpoint.');
  if (canonicalJson(review.input) !== canonicalJson(sharedReviewInput(record, review.answer, review.generation, review.previousResult)) || review.reviewedHash !== featureInputHash(record.accepted)) throw Error('Ready Check input differs from the accepted request revision.');
  if (review.previousResult) parseReadyReviewResult({ schemaVersion: 1, ...review.previousResult });
  if (review.result) parseReadyReviewResult({ schemaVersion: 1, ...review.result });
  if (review.implementationReady && (review.status !== 'passed' || !review.result?.passed) || record.submitted && !review.implementationReady) throw Error('Ready Check has not authorized implementation admission.');
  if (review.attempt && (review.attempt.operationId !== review.input.operationId || review.attempt.sessionId !== readyReviewSessionId(review.input) || typeof review.attempt.turnId !== 'string' || review.attempt.runId !== null && typeof review.attempt.runId !== 'string')) throw Error('Invalid Ready Check execution identity.');
  if (review.gateIssues && (!Array.isArray(review.gateIssues) || review.gateIssues.length > 64 || review.gateIssues.some(issue => typeof issue !== 'string' || issue.length > 2000))) throw Error('Invalid Ready Check readiness issues.');
}
