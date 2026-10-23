import { sharedIntakeQuestions } from './shared-intake-measurement.js';
import { featureIntakeHold } from './feature-intake-measurement.js';
import { deliveryPolicyRequiresApproval } from './delivery-policy-approval.js';
import { sharedFeatureInputHash, assertSharedFeatureReplySelection } from './shared-feature-selection.js';
import { sharedFeatureRequestReference } from './feature-request-reference.js';
import { featureInputHash } from './feature-workflow.js';
import { readyReviewCandidate } from './ready-review-notes.js';
import { readyReviewSessionId, type ReadyReviewInput, type ReadyReviewResult } from './ready-review-contracts.js';
import { sharedHash } from './shared-feature-notes.js';
import type { SharedFeatureRecord, SharedIntakePorts, SharedReadyReviewCheckpoint, SharedRepositoryPort } from './shared-feature-state.js';

export function sharedReviewInput(record: SharedFeatureRecord, answer: string, generation: number, previousResult?: ReadyReviewResult): ReadyReviewInput {
  const feature = sharedFeatureRequestReference(record), prompt = record.workflow.readyReview!.prompt;
  const markdown = readyReviewCandidate(record.sourceMarkdown, answer);
  return {
    operationId: 'ready-review-' + sharedHash(feature.key + generation + featureInputHash(record.accepted) + prompt.sha256).slice(0, 48),
    feature, source: { commit: record.sourceCommit, path: record.sourcePath, sha256: sharedHash(markdown), markdown },
    ...(record.selection ? { selection: structuredClone(record.selection) } : {}),
    ...(record.deliveryExecution ? { definition: structuredClone(record.deliveryExecution.definition ?? null) } : {}),
    ...(record.deliveryPolicy && deliveryPolicyRequiresApproval(record.deliveryPolicy.configuration) ? { deliveryAuthority: { repositoryId: record.binding.repositoryId, configurationDigest: record.deliveryPolicy.configurationDigest } } : {}),
    ...(previousResult ? { previousAssessment: structuredClone(previousResult) } : {}),
    prompt: structuredClone(prompt), title: record.title, provider: record.selection?.provider ?? record.accepted.provider as ReadyReviewInput['provider'], generation,
    ...(record.accepted.definitionId ? { definitionId: record.accepted.definitionId } : {}),
    ...(record.accepted.definitionRef ? { definitionRef: record.accepted.definitionRef } : {}),
    ...(record.accepted.agent ? { agent: record.accepted.agent } : {}),
    ...(record.accepted.useInstructionsOnly === undefined ? {} : { useInstructionsOnly: record.accepted.useInstructionsOnly }),
  };
}
export function sharedReviewCheckpoint(record: SharedFeatureRecord, answer = '', previous?: SharedReadyReviewCheckpoint): SharedReadyReviewCheckpoint {
  const generation = (previous?.generation ?? 0) + 1, input = sharedReviewInput(record, answer, generation, previous?.result);
  return { input, generation, status: 'queued', answer, ...(previous?.result ? { previousResult: structuredClone(previous.result) } : {}), reviewedHash: featureInputHash(record.accepted),
    sessionIds: [...new Set([...(previous?.sessionIds ?? []), readyReviewSessionId(input)])] };
}

type Publish = (record: SharedFeatureRecord, repository: SharedRepositoryPort, signal: AbortSignal) => Promise<void>;
/** One pre-implementation phase on the owned Feature Request, sharing its Git outbox. */
export class SharedReadyReviewLifecycle {
  private ports: SharedIntakePorts;
  private save: () => Promise<void>;
  private publish: Publish;
  constructor(ports: SharedIntakePorts, save: () => Promise<void>, publish: Publish) { this.ports = ports; this.save = save; this.publish = publish; }
  private async retain(record: SharedFeatureRecord, repository: SharedRepositoryPort, signal: AbortSignal) {
    const changed = sharedHash(this.ports.renderSource(record)) !== record.publishedState;
    if (changed) record.updatedAt = new Date().toISOString();
    await this.save(); if (changed) await this.publish(record, repository, signal);
  }
  async reconcile(record: SharedFeatureRecord, repository: SharedRepositoryPort, signal: AbortSignal): Promise<boolean> {
    let state = record.readyReviewState;
    if (!state || state.implementationReady) return true;
    if (!this.ports.readyReview || !this.ports.readyReviewEligible || !this.ports.readyReviewResponse) throw Error('This worker cannot run the configured Feature Request Ready Check. Update the worker before continuing.');
    let execution = this.ports.readyReview.inspect(state.input);
    const head = await repository.head(signal), current = await repository.readBlob(head, record.sourcePath, signal);
    if (current === null) throw Error('The Ready Check Feature Request is missing from the shared branch. Restore it before continuing.');
    if (sharedHash(current) !== record.remoteRevision) {
      if (execution && ['queued', 'running'].includes(execution.state)) return false;
      const response = this.ports.readyReviewResponse(current, record);
      if (response.status !== 'ready') return false;
      const eligible = this.ports.readyReviewEligible(readyReviewCandidate(response.sourceMarkdown, response.answer), record.workflow, record.accepted.provider);
      if (!eligible.valid || !eligible.input || !eligible.inputHash) throw Error(eligible.errors.map(issue => issue.message).join(' '));
      assertSharedFeatureReplySelection(record, eligible.input);
      const issue = this.ports.admissionIssue?.(eligible.input); if (issue) throw Error(issue);
      if (eligible.inputHash === state.reviewedHash) return false;
      if (execution?.result) state.result = structuredClone(execution.result);
      if (response.answer.trim()) this.ports.observeMetric?.(record, { observations: sharedIntakeQuestions(state, 'clarification_answer') });
      // Adopt the exact pushed edit before any new publication; CAS never restores the previous author body.
      record.sourceMarkdown = response.sourceMarkdown; record.sourceCommit = head; record.remoteRevision = sharedHash(current);
      record.accepted = eligible.input; record.title = eligible.input.title; record.inputHash = sharedFeatureInputHash(record);
      record.readyReviewState = state = sharedReviewCheckpoint(record, response.answer, state);
      record.status = 'reviewing_ready'; record.ready = null; record.error = null;
      record.progress = 'Your committed changes are queued for another Feature Request Ready Check.';
      await this.retain(record, repository, signal);
      if (record.remoteRevision !== record.publishedState || sharedHash(this.ports.renderSource(record)) !== record.publishedState) return false;
      execution = this.ports.readyReview.inspect(state.input);
    }
    if (state.status === 'waiting_input' || state.status === 'failed') return false;
    if (!execution && state.attempt) {
      state.status = 'failed'; record.status = 'blocked'; record.error = reviewFailure('evidence_unavailable'); record.progress = record.error;
      await this.retain(record, repository, signal); return false;
    }
    if (!execution) {
      const hold = this.ports.admissionHold?.();
      if (hold || !this.ports.canAdmit()) {
        this.ports.observeMetric?.(record, { phase: 'waiting_input', feedback: true, blockers: [featureIntakeHold(hold?.code ?? 'capacity')] });
        record.progress = hold?.message ?? 'The Feature Request Ready Check is waiting for worker capacity.';
        await this.retain(record, repository, signal); return false;
      }
      // Re-persist the immutable reservation before every admission attempt. The runner deduplicates this operation.
      await this.save();
      try { state.attempt = await this.ports.readyReview.schedule(state.input); }
      catch (error) {
        const observed = this.ports.readyReview.inspect(state.input);
        if (observed?.runId) this.ports.observeMetric?.(record, { providerRunId: observed.runId });
        throw error;
      }
      await this.save();
      execution = this.ports.readyReview.inspect(state.input);
      if (!execution) throw Error('Ready Check admission is not confirmed. Its saved operation will be inspected before retrying.');
    }
    state.attempt = { operationId: execution.operationId, sessionId: execution.sessionId, turnId: execution.turnId, runId: execution.runId };
    if (execution.state === 'queued' || execution.state === 'running') {
      state.status = execution.state; record.status = 'reviewing_ready'; record.error = null;
      record.progress = execution.state === 'queued' ? 'Feature Request Ready Check is queued before Definition of Ready.' : 'The model is reviewing this Feature Request before Definition of Ready.';
      await this.retain(record, repository, signal); return false;
    }
    if (execution.state !== 'completed' || !execution.result) {
      state.status = 'failed'; record.status = 'blocked';
      record.error = reviewFailure(execution.error);
      record.progress = record.error;
      await this.retain(record, repository, signal); return false;
    }
    state.result = structuredClone(execution.result);
    if (!state.result.passed) {
      state.status = 'waiting_input'; record.status = 'waiting_ready_input'; record.error = null;
      record.progress = 'Answer the Ready Check questions in this Feature Request, update its details if needed, set status to ready, then commit and push.';
      await this.retain(record, repository, signal); return false;
    }
    const ready = this.ports.ready(readyReviewCandidate(record.sourceMarkdown, state.answer), record.workflow, record.accepted.provider);
    if (!ready.valid || !ready.input || !ready.inputHash) {
      state.status = 'waiting_input'; state.gateIssues = ready.errors.slice(0, 8).map(issue => readinessIssue(issue.message));
      record.status = 'waiting_ready_input'; record.ready = { passed: false, issues: state.gateIssues }; record.error = null;
      record.progress = 'The Ready Check passed, but Definition of Ready still needs changes. Update this Feature Request, set status to ready, then commit and push for another review.';
      await this.retain(record, repository, signal); return false;
    }
    record.accepted = ready.input; record.inputHash = sharedFeatureInputHash(record);
    state.status = 'passed'; state.implementationReady = true;
    record.ready = { passed: true, issues: [] }; record.status = 'queued'; record.error = null;
    record.progress = 'Feature Request Ready Check and Definition of Ready passed. Implementation is queued.';
    await this.retain(record, repository, signal);
    return state.implementationReady === true;
  }
}
function reviewFailure(code?: string): string {
  const reasons: Record<string, string> = { worker_restarted: 'The worker restarted before the Ready Check result was confirmed.', protocol: 'The model returned an invalid Ready Check result.', interrupted: 'The Ready Check was interrupted before a result was confirmed.', evidence_unavailable: 'The saved Ready Check execution evidence is unavailable.', unavailable: 'The model connection was unavailable.', rate_limit: 'The model connection reached its current rate limit.', quota: 'The model account reached its allowance.', consumption_limit: 'The worker consumption limit stopped this review.', authentication: 'The model connection could not authenticate.' };
  const reason = code && reasons[code] || 'The Ready Check stopped without a validated result.';
  return reason + ' Resolve the cause, add recovery guidance in Answers, set status to ready, then commit and push to request a new review.';
}


function readinessIssue(value: string): string {
  let result = '', bytes = 0;
  for (const character of value) { const size = Buffer.byteLength(character); if (bytes + size > 256) return result + '…'; result += character; bytes += size; }
  return result;
}
