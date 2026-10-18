import { DomainError } from '../../shared/errors.js';
import { gateDigest } from './request-gates.js';
import { DEFAULT_MAX_RUNTIME_MS } from './execution-policy.js';
import { executeModel, modelCapabilities, prepareModelRequest, ProviderModelError, type ModelProvider, type ModelRequest, type StructuredModel } from './model-contract.js';
import type { ModelSessionBinding } from './model-session.js';
import type { ConversationModel } from './conversation.js';
import type { InteractionTurn } from './interactions.js';
import type { InteractionJournal, RunJournal } from './journal-ports.js';
import { unknownUsage } from './run-evidence.js';
import type { SerialExecutor } from './serial-executor.js';
import { readyReviewSessionId, validateReadyReviewInput, type ReadyReviewAttempt, type ReadyReviewExecutionView, type ReadyReviewInput, type ReadyReviewPort } from './ready-review-contracts.js';
import { readyReviewMessage, readyReviewResult } from './ready-review-protocol.js';

export interface ReadyReviewOptions {
  interactions: InteractionJournal; runs: RunJournal; executor: SerialExecutor;
  profile(input: ReadyReviewInput): ModelProvider;
  model(profile: ModelProvider, binding: ModelSessionBinding): ConversationModel | undefined;
  assertCanAdmit(): void;
  maxRuntimeMs?: () => number;
}
interface Prepared { attempt: ReadyReviewAttempt; model: ConversationModel; dispatch: ModelRequest; }
interface Context { kind: 'feature_ready_review'; input: ReadyReviewInput; provider: ModelProvider; }
interface Job { digest: string; controller: AbortController; acceptance: Promise<Prepared>; done: Promise<void>; }
const bindingFor = (input: ReadyReviewInput): ModelSessionBinding => ({ schemaVersion: 1, logicalSessionId: readyReviewSessionId(input), featureRequestKey: input.feature.key, providerId: input.provider, generation: input.generation });
const attemptFor = (input: ReadyReviewInput, turn: InteractionTurn): ReadyReviewAttempt => ({ operationId: input.operationId, sessionId: readyReviewSessionId(input), turnId: turn.id, runId: turn.runId });
/** Review turns share the worker journals, permit and allowance, without inventing another FR or task. */
export class ReadyReviewManager implements ReadyReviewPort {
  private jobs = new Map<string, Job>();
  private closed = false;
  private persistenceError = false;
  private readonly options: ReadyReviewOptions;
  constructor(options: ReadyReviewOptions) { this.options = options; }
  get active() { return this.jobs.size; }
  inspect(value: ReadyReviewInput): ReadyReviewExecutionView | undefined {
    const input = validateReadyReviewInput(value), sessionId = readyReviewSessionId(input);
    const turn = this.options.interactions.operation(sessionId, input.operationId);
    if (!turn) return undefined;
    const context = turn.context as Partial<Context> | null;
    if (context?.kind !== 'feature_ready_review' || gateDigest(context.input) !== gateDigest(input)
      || !context.provider || context.provider.id !== input.provider
      || input.selection && (context.provider.model !== input.selection.model || context.provider.effort !== input.selection.effort)
      || typeof context.provider.model !== 'string' || typeof context.provider.instruction !== 'string')
      throw new DomainError('conflict', 'Ready Check evidence does not match the accepted source and provider.');
    if (turn.dispatch && (gateDigest(turn.dispatch.provider) !== gateDigest(context.provider)
      || gateDigest(turn.dispatch.session) !== gateDigest(bindingFor(input))
      || turn.dispatch.policy.tools !== (input.provider === 'cursor-cli' ? 'provider_native' : 'none') || turn.dispatch.policy.filesystem !== (input.provider === 'cursor-cli' ? 'provider_permissions' : 'read_only') || turn.dispatch.toolManifest || turn.dispatch.operation !== 'chat'
      || turn.dispatch.messages.length !== 1 || turn.dispatch.messages[0]?.text !== readyReviewMessage(input, turn.createdAt).text))
      throw new DomainError('conflict', 'Ready Check dispatch does not match its frozen review scope.');
    const attempt = attemptFor(input, turn);
    if (turn.result) {
      try {
        const run = turn.runId ? this.options.runs.get(turn.runId) : undefined;
        if (!run || run.sessionId !== sessionId || run.taskId !== sessionId || run.purpose !== 'gate_review'
          || run.provider !== context.provider.id || run.model !== context.provider.model)
          return { ...attempt, state: 'failed', error: 'evidence_mismatch' };
        if (run.outcome !== 'completed') return { ...attempt, state: this.jobs.has(sessionId) && !this.persistenceError ? 'running' : 'failed', error: 'evidence_unavailable' };
        return { ...attempt, state: 'completed', result: readyReviewResult(turn.result) };
      }
      catch { return { ...attempt, state: 'failed', error: 'protocol' }; }
    }
    if (turn.status === 'queued' || turn.status === 'running') return { ...attempt, state: this.jobs.has(sessionId) ? turn.status : 'interrupted', ...(!this.jobs.has(sessionId) ? { error: 'result_unavailable' } : {}) };
    return { ...attempt, state: turn.status === 'interrupted' || turn.status === 'cancelled' ? 'interrupted' : 'failed', error: turn.errorCode ?? 'result_unavailable' };
  }
  async schedule(value: ReadyReviewInput): Promise<ReadyReviewAttempt> {
    const input = validateReadyReviewInput(value), sessionId = readyReviewSessionId(input), digest = gateDigest(input);
    const pending = this.jobs.get(sessionId);
    if (pending) {
      if (pending.digest !== digest) throw new DomainError('conflict', 'This Feature Request already has an active Ready Check.');
      return (await pending.acceptance).attempt;
    }
    const existing = this.inspect(input);
    if (existing) return { operationId: existing.operationId, sessionId, turnId: existing.turnId, runId: existing.runId };
    if (this.closed || this.persistenceError) throw new DomainError('unavailable', 'Ready Check execution is unavailable until the worker is restarted.');
    this.options.assertCanAdmit();
    const controller = new AbortController();
    const acceptance = Promise.resolve().then(() => this.prepare(input, controller.signal));
    const done = acceptance.then(prepared => this.execute(input, prepared, controller)).catch(() => {}).finally(() => { this.jobs.delete(sessionId); });
    this.jobs.set(sessionId, { digest, controller, acceptance, done });
    return (await acceptance).attempt;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map(job => job.done));
  }
  private async prepare(input: ReadyReviewInput, signal: AbortSignal): Promise<Prepared> {
    const sessionId = readyReviewSessionId(input);
    let turn: InteractionTurn | undefined, runId: string | undefined;
    try {
      signal.throwIfAborted();
      const provider = structuredClone(this.options.profile(input));
      if (provider.id !== input.provider || input.selection && (provider.model !== input.selection.model || provider.effort !== input.selection.effort))
        throw new DomainError('conflict', 'Ready Check provider, model and effort do not match the accepted selection.');
      const context: Context = { kind: 'feature_ready_review', input, provider };
      turn = this.options.interactions.accept({ sessionId, operationId: input.operationId, kind: 'message',
        input: `Ready Check for ${input.feature.id} at ${input.source.commit}`, context }).turn;
      const binding = bindingFor(input), model = this.options.model(provider, binding);
      if (!model) throw new ProviderModelError('unavailable');
      // Strip supplemental tools. Cursor retains its disclosed native permissions and runs this chat in ask mode.
      const frozen = { reply: model.reply.bind(model), configuration: provider, sessionBinding: binding,
        capabilities: { ...((model as Partial<StructuredModel>).capabilities ?? modelCapabilities), tools: provider.id === 'cursor-cli' ? 'provider_native' : 'none' } } as ConversationModel;
      const dispatch = prepareModelRequest(frozen, [readyReviewMessage(input, turn.createdAt)], 'chat', this.options.maxRuntimeMs?.() ?? DEFAULT_MAX_RUNTIME_MS);
      runId = (await this.options.runs.begin({ sessionId, taskId: sessionId, kind: 'local', purpose: 'gate_review', title: 'Ready Check: ' + input.title,
        provider: provider.id, model: provider.model })).id;
      this.options.interactions.prepare(sessionId, turn.id, dispatch, runId);
      signal.throwIfAborted();
      return { attempt: { operationId: input.operationId, sessionId, turnId: turn.id, runId }, model, dispatch };
    } catch (error) {
      if (turn) {
        try { this.options.interactions.fail(sessionId, turn.id, signal.aborted ? 'interrupted' : 'failed', this.errorCode(error, signal)); }
        catch { this.failEvidence(); }
      }
      if (runId) {
        try { await this.options.runs.finish(runId, signal.aborted ? 'interrupted' : 'failed'); }
        catch { this.failEvidence(); }
      }
      throw error;
    }
  }
  private async execute(input: ReadyReviewInput, prepared: Prepared, controller: AbortController): Promise<void> {
    const { attempt, model, dispatch } = prepared, { sessionId, turnId } = attempt, runId = attempt.runId!;
    let release: (() => void) | undefined, signal = controller.signal, usage = unknownUsage();
    let outcome: 'completed' | 'failed' | 'interrupted' = 'failed';
    try {
      release = await this.options.executor.acquire(sessionId, controller.signal);
      signal = AbortSignal.any([controller.signal, AbortSignal.timeout(dispatch.policy.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS)]);
      if (this.persistenceError) throw new DomainError('unavailable', 'Ready Check evidence storage is unavailable.');
      this.inspect(input); // Verify the durable scope again before any paid call.
      await this.options.runs.start(runId);
      this.options.interactions.start(sessionId, turnId);
      signal.throwIfAborted();
      const result = await executeModel(model, dispatch, signal, value => {
        usage = value;
        try { this.options.runs.observeUsage(runId, value); this.options.interactions.observeUsage(sessionId, turnId, value); }
        catch { this.failEvidence(); }
      });
      if (this.persistenceError) throw new DomainError('unavailable', 'Ready Check evidence storage is unavailable.');
      const parsed = readyReviewResult(result);
      // Normalize typed questions to a completed review assessment. Team answers are new committed revisions.
      this.options.interactions.complete(sessionId, turnId, { type: 'completed', text: JSON.stringify({ schemaVersion: 1, ...parsed }) }, usage);
      outcome = 'completed';
    } catch (error) {
      let saved = false;
      try { saved = !!this.options.interactions.turn(sessionId, turnId).result; }
      catch { this.failEvidence(); }
      if (saved) outcome = 'completed';
      else {
        outcome = controller.signal.aborted ? 'interrupted' : 'failed';
        try { this.options.interactions.fail(sessionId, turnId, outcome, this.errorCode(error, signal)); }
        catch { this.failEvidence(); }
      }
    }
    try { await this.options.runs.finish(runId, outcome, usage); }
    catch { this.failEvidence(); }
    release?.();
  }
  private failEvidence(): void {
    this.persistenceError = true;
    for (const job of this.jobs.values()) job.controller.abort();
  }
  private errorCode(error: unknown, signal: AbortSignal): string {
    return this.persistenceError ? 'evidence_unavailable' : this.closed ? 'interrupted' : signal.aborted ? 'timeout' : error instanceof ProviderModelError ? error.code : error instanceof DomainError ? error.code : 'execution_failed';
  }
}
