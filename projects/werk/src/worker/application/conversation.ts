import { DEFAULT_MAX_RUNTIME_MS } from './execution-policy.js';
import { unknownUsage, type ProviderUsage, type RunEvidence, type RunMetadata } from './run-evidence.js';
import { executeModel, prepareModelRequest, ProviderModelError, type ModelRequest } from './model-contract.js';
import type { InteractionCommand, InteractionStore, InteractionTurn } from './interactions.js';
import type { SerialExecutor } from './serial-executor.js';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../../shared/errors.js';
export interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; at: string; state: 'complete' | 'pending' | 'error' | 'cancelled'; }
export interface Conversation { messages: ChatMessage[]; }
export interface ConversationStore { read(): Promise<Conversation>; write(value: Conversation): Promise<void>; }
export interface ConversationModel { reply(messages: ChatMessage[], signal: AbortSignal, onUsage?: (usage: ProviderUsage) => void): Promise<string>; }
type Evidence = { journal: RunEvidence; metadata: () => RunMetadata; interactions?: InteractionStore };
type ChatContext = { chatMessages: ChatMessage[]; assistantId: string };

/** One session; persisted interaction results are authoritative over transcript projections. */
export class WorkerConversation {
  private value: Conversation = { messages: [] };
  private controller?: AbortController;
  private pending?: Promise<void>;
  private changing = false;
  private persistenceError = false;
  private store: ConversationStore;
  private model?: ConversationModel;
  private timeoutMs: number | (() => number);
  private accepting?: Promise<void>;
  private closed = false;
  private phase: 'idle' | 'queued' | 'running' = 'idle';
  private executor?: SerialExecutor;
  private sessionId: string;
  private evidence?: Evidence;

  constructor(store: ConversationStore, model?: ConversationModel, timeoutMs: number | (() => number) = DEFAULT_MAX_RUNTIME_MS, executor?: SerialExecutor, sessionId = 'default', evidence?: Evidence) {
    this.store = store; this.model = model; this.timeoutMs = timeoutMs;
    this.executor = executor; this.sessionId = sessionId; this.evidence = evidence;
  }

  async init() {
    this.value = await this.store.read();
    const interactions = this.evidence?.interactions;
    const latest = interactions?.view(this.sessionId).latestTurn;
    if (latest) {
      const turn = interactions!.turn(this.sessionId, latest.id);
      const context = turn.context as Partial<ChatContext> | null;
      if (context && Array.isArray(context.chatMessages) && typeof context.assistantId === 'string') {
        this.value = { messages: structuredClone(context.chatMessages) };
        const answer = this.value.messages.find(message => message.id === context.assistantId);
        if (answer) this.materialize(turn, answer);
        await this.store.write(this.value);
      }
    }
    if (this.value.messages.some(message => message.state === 'pending')) {
      for (const message of this.value.messages) if (message.state === 'pending') {
        message.state = 'error'; message.text = 'The worker stopped before this reply finished. Resume the stopped attempt to try again.';
      }
      await this.store.write(this.value);
    }
  }

  private materialize(turn: InteractionTurn, answer: ChatMessage) {
    if (turn.result) {
      answer.state = 'complete';
      answer.text = turn.result.type === 'completed' ? turn.result.text : turn.result.request.message;
    } else {
      answer.state = turn.status === 'cancelled' ? 'cancelled' : 'error';
      answer.text = turn.status === 'cancelled' ? 'Reply stopped.' : 'This attempt did not finish. Resume it explicitly to make a new model request.';
    }
  }

  snapshot() { return { ...structuredClone(this.value), available: !!this.model, busy: this.changing, phase: this.phase, persistenceError: this.persistenceError }; }

  async start(text: unknown) {
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new DomainError('invalid_input', 'Send a message containing 1–8,000 characters.');
    if (!this.model) throw new DomainError('unavailable', 'No model configured. Open Dashboard to connect a provider.');
    await this.launch(text.trim());
    return this.snapshot();
  }

  async interact(command: InteractionCommand) {
    if (!this.evidence?.interactions) throw new DomainError('unavailable', 'Durable interactions are unavailable for this session.');
    const input = command.action === 'answer' ? command.answer : command.message ?? '';
    if (typeof input !== 'string') throw new DomainError('invalid_input', 'Provide a text answer.');
    await this.launch(input.trim(), command);
    return this.evidence.interactions.view(this.sessionId);
  }

  private async launch(text: string, command?: InteractionCommand) {
    if (this.closed) throw new DomainError('unavailable', 'Worker is stopping.');
    const interactions = this.evidence?.interactions;
    const previous = this.value;
    const at = new Date().toISOString();
    const answer: ChatMessage = { id: randomUUID(), role: 'assistant', text: '', state: 'pending', at };
    const user: ChatMessage[] = command?.action === 'resume' && !text ? [] : [{ id: randomUUID(), role: 'user', text, at, state: 'complete' }];
    const next: Conversation = { messages: [...previous.messages, ...user, answer] };
    let turn: InteractionTurn | undefined;
    if (interactions) {
      const admission = interactions.accept({
        sessionId: this.sessionId, kind: command?.action ?? 'message', operationId: command?.operationId ?? randomUUID(),
        ...(command ? { expectedRevision: command.expectedRevision, pendingId: command.pendingId, priorTurnId: command.turnId } : {}),
        input: text, context: { chatMessages: next.messages, assistantId: answer.id } satisfies ChatContext
      });
      if (admission.duplicate) return;
      turn = admission.turn;
    }
    if (this.changing || !this.model || this.value.messages.length >= 60 || this.value.messages.reduce((size, item) => size + item.text.length, text.length) > 48000) {
      if (turn) interactions!.fail(this.sessionId, turn.id, 'failed', 'admission_unavailable');
      if (this.changing) throw new DomainError('conflict', 'A reply is already running. Wait or stop it first.');
      if (!this.model) throw new DomainError('unavailable', 'No model configured. Open Dashboard to connect a provider.');
      throw new DomainError('conflict', 'This task session is full. Create a new task to continue.');
    }
    const maxRuntimeMs = typeof this.timeoutMs === 'function' ? this.timeoutMs() : this.timeoutMs;
    let request: ModelRequest;
    try {
      if (turn?.priorTurnId) {
        const prior = interactions!.turn(this.sessionId, turn.priorTurnId);
        if (prior.dispatch) {
          const messages = structuredClone(prior.dispatch.messages);
          if ((command?.action === 'answer' || text) && prior.result?.type === 'needs_input') messages.push({ id: prior.id, role: 'assistant', text: JSON.stringify({ werkInteraction: prior.result.request }), at: prior.finishedAt!, state: 'complete' });
          if (text) messages.push(...user);
          // Retain the original provider/instruction profile while rendering the explicit continuation.
          request = prepareModelRequest({ ...this.model, configuration: prior.dispatch.provider } as ConversationModel, messages, 'chat', maxRuntimeMs);
        } else {
          // An answer can be durable before dispatch preparation. Recover its saved input,
          // including the accepted answer, using the nearest frozen provider profile.
          const context = prior.context as Partial<ChatContext> | null;
          let ancestor = prior;
          for (let depth = 0; !ancestor.dispatch && ancestor.priorTurnId && depth < 100; depth++) ancestor = interactions!.turn(this.sessionId, ancestor.priorTurnId);
          const messages = structuredClone(context?.chatMessages ?? next.messages).filter(item => item.state === 'complete');
          if (ancestor.result?.type === 'needs_input') {
            const original = ancestor.context as Partial<ChatContext> | null;
            const question = messages.find(message => message.id === original?.assistantId);
            if (question) question.text = JSON.stringify({ werkInteraction: ancestor.result.request });
          }
          if (text) messages.push(...user);
          const model = ancestor.dispatch ? { ...this.model, configuration: ancestor.dispatch.provider } as ConversationModel : this.model;
          request = prepareModelRequest(model, messages, 'chat', maxRuntimeMs);
        }
      } else request = prepareModelRequest(this.model, next.messages.filter(item => item.state === 'complete'), 'chat', maxRuntimeMs);
    } catch (error) {
      if (turn) interactions!.fail(this.sessionId, turn.id, 'failed', 'request_invalid');
      throw error;
    }
    this.changing = true; this.phase = 'queued'; this.value = next;
    this.controller = new AbortController();
    const controller = this.controller;
    this.accepting = this.store.write(this.value);
    try { await this.accepting; }
    catch (error) {
      this.value = previous; this.changing = false; this.phase = 'idle';
      if (turn) interactions!.fail(this.sessionId, turn.id, 'failed', 'transcript_write_failed');
      throw error;
    }
    let signal = controller.signal;
    this.pending = (async () => {
      let release: (() => void) | undefined, runId: string | undefined, evidenceError = false;
      let usage = unknownUsage();
      let outcome: 'completed' | 'waiting_input' | 'escalated' | 'failed' | 'cancelled' = 'failed';
      try {
        if (this.evidence) {
          const metadata = this.evidence.metadata();
          if (request.provider.id !== 'legacy') { metadata.provider = request.provider.id; metadata.model = request.provider.model; }
          try {
            runId = (await this.evidence.journal.begin(metadata)).id;
            if (turn) interactions!.prepare(this.sessionId, turn.id, request, runId);
          } catch (error) { evidenceError = true; throw error; }
        }
        release = await this.executor?.acquire(this.sessionId, controller.signal);
        signal = AbortSignal.any([controller.signal, AbortSignal.timeout(request.policy.maxRuntimeMs ?? maxRuntimeMs)]);
        this.phase = 'running';
        if (runId) {
          try { await this.evidence!.journal.start(runId); if (turn) interactions!.start(this.sessionId, turn.id); }
          catch (error) { evidenceError = true; throw error; }
        }
        signal.throwIfAborted();
        const result = await executeModel(this.model!, request, signal, value => {
          usage = value;
          if (runId) { try { this.evidence!.journal.observeUsage?.(runId, value); if (turn) interactions!.observeUsage(this.sessionId, turn.id, value); } catch { evidenceError = true; } }
        });
        signal.throwIfAborted();
        if (result.type === 'completed' && (!result.text.trim() || result.text.length > 32000)) throw new ProviderModelError('protocol');
        if (turn) interactions!.complete(this.sessionId, turn.id, result, usage);
        answer.text = result.type === 'completed' ? result.text : result.request.message;
        answer.state = 'complete';
        outcome = result.type === 'completed' ? 'completed' : result.request.kind === 'question' ? 'waiting_input' : 'escalated';
      } catch (error) {
        outcome = controller.signal.aborted ? 'cancelled' : 'failed';
        answer.state = controller.signal.aborted ? 'cancelled' : 'error';
        const code = controller.signal.aborted ? 'cancelled' : signal.aborted ? 'timeout' : error instanceof ProviderModelError ? error.code : 'execution_failed';
        answer.text = controller.signal.aborted ? 'Reply stopped.' : signal.aborted ? 'This attempt reached its configured execution time limit. Its saved context is retained; resume explicitly to make another attempt.' : error instanceof ProviderModelError ? error.message : 'The model could not reply. Check this session’s provider connection and authentication, then try again.';
        if (turn) { try { interactions!.fail(this.sessionId, turn.id, outcome, code); } catch { evidenceError = true; } }
      }
      if (runId) { try { await this.evidence!.journal.finish(runId, outcome, usage); } catch { evidenceError = true; } }
      try { await this.store.write(this.value); this.persistenceError = evidenceError; }
      catch { this.persistenceError = true; }
      finally { this.changing = false; this.phase = 'idle'; this.controller = undefined; release?.(); }
    })();
  }
  async prepareTask(input: string) {
    if (this.changing) throw new DomainError('conflict', 'This task session is already executing.');
    if (this.value.messages.length) return;
    const next: Conversation = { messages: [{ id: randomUUID(), role: 'user', text: input.slice(0, 8000), at: new Date().toISOString(), state: 'complete' }] };
    await this.store.write(next); this.value = next;
  }
  async recordTask(input: string, output: string, failed = false) {
    if (this.changing) throw new DomainError('conflict', 'This task session is already executing.');
    const at = new Date().toISOString();
    const last = this.value.messages.at(-1);
    const request: ChatMessage[] = last?.role === 'user' && last.text === input.slice(0, 8000) ? [] : [{ id: randomUUID(), role: 'user', text: input.slice(0, 8000), at, state: 'complete' }];
    const messages: ChatMessage[] = [...this.value.messages, ...request, { id: randomUUID(), role: 'assistant', text: output.slice(0, 16000), at, state: failed ? 'error' : 'complete' }];
    while (messages.length > 2 && (messages.length > 60 || messages.reduce((size, message) => size + message.text.length, 0) > 48000)) messages.splice(0, 2);
    const next = { messages }; await this.store.write(next); this.value = next;
  }
  async close() { this.closed = true; this.controller?.abort(); await this.accepting?.catch(() => {}); await this.pending; }
  async cancel() { this.controller?.abort(); await this.accepting?.catch(() => {}); await this.pending; this.evidence?.interactions?.abandon(this.sessionId); return this.snapshot(); }
  async clear() {
    if (this.changing) throw new DomainError('conflict', 'Stop the current reply before starting a new conversation.');
    this.changing = true;
    try { await this.store.write({ messages: [] }); this.evidence?.interactions?.deleteSession(this.sessionId); this.value = { messages: [] }; this.persistenceError = false; }
    finally { this.changing = false; }
    return this.snapshot();
  }
}
