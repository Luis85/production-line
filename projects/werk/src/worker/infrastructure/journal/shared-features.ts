import { parseFeature } from '../features/document.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { atomicWrite, readBoundedFile } from './files.js';
import { defaultSharedIntakeConfig, validateSharedIntakeConfig, bindingKey, type SharedFeatureState } from '../../application/shared-feature-state.js';
import { sharedHash, sharedFeaturePublicationDigest } from '../../application/shared-feature-notes.js';
import { validateFeatureWorkflow, validateFeatureCheck, featureWorkflowPolicy } from '../../application/feature-workflow.js';
import { gateDigest } from '../../application/request-gates.js';
import { validateFeatureReadiness } from '../features/workflow.js';

/** Private recovery journal. No claim is dispatched from an unvalidated or partially written record. */
export class SharedFeatureJournal {
  private path: string;
  private writes = Promise.resolve();
  constructor(directory: string) { this.path = join(directory, 'shared-intake.json'); }
  async load(): Promise<SharedFeatureState> {
    try {
      const state = JSON.parse(await readBoundedFile(this.path, 16777216)) as SharedFeatureState;
      if (state.schemaVersion !== 1 || !/^[a-zA-Z0-9_-]{1,100}$/.test(state.workerId) || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.records) || state.records.length > 100 || new Set(state.records.map(r => bindingKey(r.binding) + r.id)).size !== state.records.length) throw Error('Invalid shared intake journal.');
      validateSharedIntakeConfig(state.config);
      for (const record of state.records) {
        validateSharedIntakeConfig(record.binding);
        const snapshot = record.workflow;
        validateFeatureWorkflow(snapshot.configuration);
        validateFeatureCheck(snapshot.readyCheck, 'ready'); validateFeatureCheck(snapshot.doneCheck, 'done');
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.sourceCommit) || snapshot.commit !== record.sourceCommit || snapshot.policyDigest !== gateDigest(snapshot.policy) || snapshot.policyDigest !== gateDigest(featureWorkflowPolicy(snapshot.readyCheck, snapshot.doneCheck, snapshot.configuration.id)) || sharedHash(snapshot.template) !== snapshot.files.template.sha256) throw Error('Invalid frozen shared workflow.');
        const readiness = validateFeatureReadiness(record.sourceMarkdown, snapshot.readyCheck, record.accepted.provider, snapshot.template, { configuration: snapshot.configuration, workflowPath: snapshot.files.configuration.path });
        if (!readiness.valid || !readiness.input || record.id !== readiness.input.id || JSON.stringify(record.accepted) !== JSON.stringify(readiness.input) || record.owner !== state.workerId || record.taskId !== 'shared-feature-' + sharedHash(record.id + bindingKey(record.binding)).slice(0, 32)) throw Error('Invalid accepted shared feature.');
        if (record.inputHash !== sharedHash(readiness.inputHash! + snapshot.policyDigest + record.sourceCommit + sharedHash(record.sourceMarkdown)) || typeof record.claimed !== 'boolean' || typeof record.submitted !== 'boolean' || record.submitted && !record.claimed || !/^[a-f0-9]{64}$/.test(record.remoteRevision)) throw Error('Invalid shared feature reservation.');
        if (record.sourcePath !== snapshot.configuration.requestsDirectory + '/' + record.name || !/^[^/\\]+\.md$/.test(record.name) || record.name.startsWith('_')) throw Error('Invalid shared feature source path.');
        if (record.featureCommit !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.featureCommit) || record.outputDigest !== undefined && !/^[a-f0-9]{64}$/.test(record.outputDigest) || record.publishedState !== undefined && !/^[a-f0-9]{64}$/.test(record.publishedState) || record.publishedReview !== undefined && (typeof record.publishedReview !== 'string' || !record.publishedReview.startsWith(snapshot.configuration.reviewDirectory + '/') || !/^[^:]+:[a-f0-9]{64}$/.test(record.publishedReview))) throw Error('Invalid shared publication checkpoint.');
        if (record.reviewNote !== null && (typeof record.outputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(record.outputDigest) || record.reviewNote !== snapshot.configuration.reviewDirectory + '/' + record.id + '-' + sharedFeaturePublicationDigest(record, record.outputDigest).slice(0, 12) + '.md' || typeof record.reviewMarkdown !== 'string' || Buffer.byteLength(record.reviewMarkdown) > 524288)) throw Error('Invalid shared review note.');
        if (record.pending) {
          const pending = record.pending;
          if (pending.request.path !== record.sourcePath || pending.request.expectedRevision !== record.remoteRevision || !/^[a-zA-Z0-9_-]{1,100}$/.test(pending.operationId) || typeof pending.request.content !== 'string' || Buffer.byteLength(pending.request.content) > 65536 || !Array.isArray(pending.artifacts) || pending.artifacts.length > 1) throw Error('Invalid shared publication outbox.');
          const publication = parseFeature(pending.request.content), original = parseFeature(record.sourceMarkdown);
          const shared = (publication.data.werk as { shared?: { owner?: string; sourceCommit?: string; sourceHash?: string } })?.shared;
          if (publication.data.id !== record.id || publication.body !== original.body || shared?.owner !== state.workerId || shared?.sourceCommit !== record.sourceCommit || shared?.sourceHash !== record.inputHash) throw Error('Invalid shared claim outbox.');
          for (const artifact of pending.artifacts) if (!artifact || artifact.path !== record.reviewNote || artifact.expectedRevision !== null || typeof artifact.content !== 'string' || artifact.content !== record.reviewMarkdown || Buffer.byteLength(artifact.content) > 524288) throw Error('Invalid shared review outbox.');
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
    const write = this.writes.catch(() => {}).then(() => atomicWrite(this.path, text));
    this.writes = write; return write;
  }
}
