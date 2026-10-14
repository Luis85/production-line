import { unknownUsage, type ProviderUsage, type RunEvidence, type RunMetadata } from './run-evidence.js';
import type { SerialExecutor } from './serial-executor.js';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../../shared/errors.js';
export interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; at: string; state: 'complete' | 'pending' | 'error' | 'cancelled'; }
export interface Conversation { messages: ChatMessage[]; }
export interface ConversationStore { read(): Promise<Conversation>; write(value: Conversation): Promise<void>; }
export interface ConversationModel { reply(messages: ChatMessage[], signal: AbortSignal, onUsage?: (usage: ProviderUsage) => void): Promise<string>; }
/** One local conversation; accepting a turn is durable before the model is invoked. */
export class WorkerConversation {
  private value: Conversation = { messages: [] };
  private controller?: AbortController;
  private pending?: Promise<void>;
  private changing = false;
  private persistenceError = false;
  private store: ConversationStore; private model?: ConversationModel; private timeoutMs: number;
  private accepting?: Promise<void>; private closed = false;
  private phase: 'idle' | 'queued' | 'running' = 'idle';
  private executor?: SerialExecutor; private sessionId: string;
  private evidence?: { journal: RunEvidence; metadata: () => RunMetadata };
  constructor(store: ConversationStore, model?: ConversationModel, timeoutMs = 120000, executor?: SerialExecutor, sessionId = 'default', evidence?: { journal: RunEvidence; metadata: () => RunMetadata }) { this.store = store; this.model = model; this.timeoutMs = timeoutMs; this.executor = executor; this.sessionId = sessionId; this.evidence = evidence; }
  async init() {
    this.value = await this.store.read();
    if (this.value.messages.some(message => message.state === 'pending')) {
      for (const message of this.value.messages) if (message.state === 'pending') { message.state = 'error'; message.text = 'The worker stopped before this reply finished. Send your message again.'; }
      await this.store.write(this.value);
    }
  }
  snapshot() { return { ...structuredClone(this.value), available: !!this.model, busy: this.changing, phase: this.phase, persistenceError: this.persistenceError }; }
  async start(text: unknown) {
    if (this.closed) throw new DomainError('unavailable', 'Worker is stopping.');
    if (!this.model) throw new DomainError('unavailable', 'No model configured. Open Dashboard to connect a provider.');
    if (this.changing) throw new DomainError('conflict', 'A reply is already running. Wait or stop it first.');
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new DomainError('invalid_input', 'Send a message containing 1–8,000 characters.');
    if (this.value.messages.length >= 60 || this.value.messages.reduce((size, item) => size + item.text.length, text.length) > 48000) throw new DomainError('conflict', 'This task session is full. Create a new task to continue.');
    this.changing = true; this.phase = 'queued';
    const previous = this.value;
    const answer: ChatMessage = { id: randomUUID(), role: 'assistant', text: '', state: 'pending', at: new Date().toISOString() };
    this.value = { messages: [...previous.messages, { id: randomUUID(), role: 'user', text: text.trim(), state: 'complete', at: answer.at }, answer] };
    this.controller = new AbortController();
    const controller = this.controller;
    this.accepting = this.store.write(this.value);
    try { await this.accepting; } catch (error) { this.value = previous; this.changing = false; this.phase = 'idle'; throw error; }
    let signal = controller.signal;
    const input = structuredClone(this.value.messages.filter(item => item.state === 'complete'));
    this.pending = (async () => {
      let release: (() => void) | undefined, runId: string | undefined, evidenceError = false;
      let usage = unknownUsage();
      try {
        if (this.evidence) { try { runId = (await this.evidence.journal.begin(this.evidence.metadata())).id; } catch (error) { evidenceError = true; throw error; } }
        release = await this.executor?.acquire(this.sessionId, controller.signal);
        signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeoutMs)]);
        this.phase = 'running';
        if (runId) { try { await this.evidence!.journal.start(runId); } catch (error) { evidenceError = true; throw error; } }
        signal.throwIfAborted();
        const reply = await this.model!.reply(input, signal, value => { usage = value; });
        signal.throwIfAborted();
        if (!reply.trim() || reply.length > 32000) throw Error('Invalid reply');
        answer.text = reply; answer.state = 'complete';
      } catch {
        answer.state = controller.signal.aborted ? 'cancelled' : 'error';
        answer.text = controller.signal.aborted ? 'Reply stopped.' : signal.aborted ? 'The model took longer than two minutes. Try a shorter message.' : 'The model could not reply. Check this session’s provider connection and authentication, then try again.';
      }
      if (runId) { try { await this.evidence!.journal.finish(runId, answer.state === 'complete' ? 'completed' : answer.state === 'cancelled' ? 'cancelled' : 'failed', usage); } catch { evidenceError = true; } }
      try { await this.store.write(this.value); this.persistenceError = evidenceError; } catch { this.persistenceError = true; }
      finally { this.changing = false; this.phase = 'idle'; this.controller = undefined; release?.(); }
    })();
    return this.snapshot();
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
  async close() { this.closed = true; await this.cancel(); }
  async cancel() { this.controller?.abort(); await this.accepting?.catch(() => {}); await this.pending; return this.snapshot(); }
  async clear() {
    if (this.changing) throw new DomainError('conflict', 'Stop the current reply before starting a new conversation.');
    this.changing = true;
    try { await this.store.write({ messages: [] }); this.value = { messages: [] }; this.persistenceError = false; }
    finally { this.changing = false; }
    return this.snapshot();
  }
}
