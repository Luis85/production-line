import { WorkerDefinitions, definitionConnection, validateSnapshot, type DefinitionSnapshot } from './definitions.js';
import { SerialExecutor } from './serial-executor.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { object, text, identifier } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import { WorkerConversation } from '../application/conversation.js';
import { FileConversationStore } from '../infrastructure/conversation.js';
import { atomicWrite, ensureDirectory, readBoundedFile } from '../infrastructure/journal/files.js';
import { modelFor, type ProviderId } from '../infrastructure/providers.js';
import type { WorkerSettings } from '../infrastructure/settings.js';
export type TaskState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface SessionRecord { definition?: DefinitionSnapshot; submissionHash?: string; taskState?: TaskState; taskId: string; kind: 'chat' | 'local' | 'orchestrator'; id: string; title: string; provider: ProviderId; createdAt: string; archived: boolean; }
/** Worker-owned transcripts are provider-independent; native CLI session IDs never cross providers. */
export class WorkerSessions {
  readonly definitions: WorkerDefinitions;
  private directory: string; private settings: WorkerSettings; private model: typeof modelFor;
  readonly executor: SerialExecutor;
  private writes = Promise.resolve();
  private protectedTasks = new Set<string>();
  protectTask(id: string, protectedTask: boolean) { if (protectedTask) this.protectedTasks.add(id); else this.protectedTasks.delete(id); }
  private records: SessionRecord[] = []; private selected = 'default';
  private instances = new Map<string, WorkerConversation>(); private changing = false;
  constructor(directory: string, settings: WorkerSettings, model: typeof modelFor = modelFor) { this.definitions = new WorkerDefinitions(directory); this.model = model; this.directory = directory; this.settings = settings; this.executor = new SerialExecutor(() => settings.value.board.paused); }
  async init() {
    await this.definitions.init();
    try { const value = JSON.parse(await readBoundedFile(join(this.directory, 'sessions.json'), 2097152));
      if (!Array.isArray(value.records) || !value.records.length || value.records.length > 100 || new Set(value.records.map((item: SessionRecord) => item.id)).size !== value.records.length) throw Error('Invalid sessions');
      for (const record of value.records) { identifier(record.id, 'session'); text(record.title, 'Session title', 120); this.settings.provider(record.provider); if (record.definition) { validateSnapshot(record.definition); definitionConnection(this.settings.provider(record.provider), record.definition); } if (typeof record.archived !== 'boolean' || !Number.isFinite(Date.parse(record.createdAt))) throw Error('Invalid session'); }
      if (!value.records.some((record: SessionRecord) => record.id === value.selected && !record.archived)) throw Error('Invalid selected session');
      this.records = value.records.map((record: SessionRecord) => ({ ...record, taskId: record.taskId ?? record.id, kind: record.kind ?? 'chat', taskState: record.kind === 'orchestrator' && ['running', 'queued'].includes(record.taskState ?? '') ? 'failed' : record.taskState })); this.selected = value.selected;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.records = [{ id: 'default', taskId: 'default', kind: 'chat', title: 'New task', provider: 'codex-cli', createdAt: new Date().toISOString(), archived: false }]; await this.persist();
    }
    for (const record of this.records) await this.load(record);
  }
  private async load(record: SessionRecord) {
    const directory = record.id === 'default' ? this.directory : join(this.directory, 'sessions', record.id);
    await ensureDirectory(directory);
    const model = this.model(definitionConnection(this.settings.provider(record.provider), record.definition), directory);
    const conversation = new WorkerConversation(new FileConversationStore(directory), model, 120000, this.executor, record.id);
    await conversation.init(); this.instances.set(record.id, conversation);
  }
  assertSelected(id: unknown) { if (id !== undefined && id !== this.selected) throw new DomainError('conflict', 'The selected session changed. Refresh before sending.'); }
  get chat() { return this.instances.get(this.selected)!; }
  get current() { return this.records.find(item => item.id === this.selected)!; }
  get chatActive() { return [...this.instances.values()].filter(item => item.snapshot().busy).length; }
  get busy() { return this.executor.busy || this.records.some(record => ['queued', 'running'].includes(record.taskState ?? '')) || [...this.instances.values()].some(item => item.snapshot().busy); }
  view() { return { selected: this.selected, execution: { currentSessionId: this.executor.current, queued: this.executor.waiting, maxParallel: 1 }, records: this.records.map(record => {
    const conversation = this.instances.get(record.id)?.snapshot(), last = conversation?.messages.at(-1);
    const status = this.executor.current === record.id ? 'running' : conversation?.busy ? 'queued' : record.taskState ?? (!last ? 'draft' : last.state === 'error' ? 'failed' : last.state === 'cancelled' ? 'cancelled' : 'completed');
    return { ...record, status, busy: (conversation?.busy ?? false) || ['queued', 'running'].includes(record.taskState ?? ''), messages: conversation?.messages.length ?? 0 };
  }) }; }
  detail(id: string) {
    const record = this.records.find(item => item.id === id);
    if (!record) throw new DomainError('not_found', 'Task session not found');
    return { session: this.view().records.find(item => item.id === id)!, chat: this.instances.get(id)!.snapshot() };
  }
  async cancelTask(id: string) {
    const { session } = this.detail(id);
    if (session.kind !== 'chat' && ['queued', 'running'].includes(session.taskState ?? '')) throw new DomainError('conflict', 'Use the owning taskboard or orchestrator to cancel this assignment.');
    await this.instances.get(id)!.cancel(); return this.detail(id);
  }
  async start(message: unknown, id = this.selected) {
    this.detail(id);
    const record = this.records.find(item => item.id === id)!, chat = this.instances.get(id)!;
    if (record.kind !== 'chat' && (['queued', 'running'].includes(record.taskState ?? '') || this.executor.current === record.id)) throw new DomainError('conflict', 'Wait for this task to finish before sending a follow-up.');
    const result = await chat.start(message);
    if (record.kind !== 'chat') { delete record.taskState; await this.persist(); }
    if (id === this.selected && record.title === 'New task' && typeof message === 'string') { record.title = message.trim().slice(0, 120); await this.persist(); }
    return result;
  }
  async ensureTask(id: string, kind: SessionRecord['kind'], title: string, provider: ProviderId, submissionHash?: string, definition?: DefinitionSnapshot) {
    const found = this.records.find(record => record.id === id); if (found) return found;
    if (this.changing) throw new DomainError('conflict', 'Session change in progress. Retry task preparation.');
    if (this.records.length >= 100) throw new DomainError('conflict', 'Task session limit reached (100). Delete old task history before accepting more.');
    this.changing = true;
    try {
      if (definition) definitionConnection(this.settings.provider(provider), definition);
      const record: SessionRecord = { ...(definition ? { definition: structuredClone(definition) } : {}), ...(submissionHash ? { submissionHash } : {}), id: identifier(id, 'task session'), taskId: id, kind, ...(kind === 'chat' ? {} : { taskState: 'queued' as const }), title: title.slice(0, 120), provider, createdAt: new Date().toISOString(), archived: false };
      await this.load(record); this.records.push(record);
      try { await this.persist(); } catch (error) { this.records = this.records.filter(item => item.id !== id); this.instances.delete(id); throw error; }
      return record;
    } finally { this.changing = false; }
  }
  async prepareTask(id: string, input: string) { const conversation = this.instances.get(id); if (!conversation) throw new DomainError('not_found', 'Task session not found'); await conversation.prepareTask(input); }
  async recordTask(id: string, input: string, output: string, failed = false) { const conversation = this.instances.get(id); if (!conversation) throw new DomainError('not_found', 'Task session not found'); await conversation.recordTask(input, output, failed); }

  async setTaskState(id: string, state: TaskState) {
    const record = this.records.find(item => item.id === id); if (!record) throw new DomainError('not_found', 'Task session not found');
    if (record.taskState === state) return;
    record.taskState = state; await this.persist();
  }
  private persist() {
    const serialized = JSON.stringify({ selected: this.selected, records: this.records });
    if (Buffer.byteLength(serialized) > 2097152) throw new DomainError('conflict', 'Task history storage is full. Delete an unused task.');
    const write = this.writes.catch(() => {}).then(() => atomicWrite(join(this.directory, 'sessions.json'), serialized));
    this.writes = write; return write;
  }
  async reloadProviders() { if (this.busy) throw new DomainError('conflict', 'Stop active replies before changing providers.'); for (const record of this.records) await this.load(record); }
  async action(input: unknown) {
    if (this.changing) throw new DomainError('conflict', 'Session change in progress.');
    this.changing = true; const previous = structuredClone({ records: this.records, selected: this.selected });
    try {
      const body = object(input, 'Session action', ['action', 'id', 'title', 'provider', 'definitionId', 'agent', 'useInstructionsOnly']);
      if (body.action === 'create') {
        if (this.records.length >= 100) throw new DomainError('conflict', 'Session limit reached (100). Delete an unused session first.');
        const provider = this.settings.provider(String(body.provider));
        const definition = this.definitions.select(body); definitionConnection(provider, definition);
        const id = randomUUID();
        const record: SessionRecord = { ...(definition ? { definition } : {}), id, taskId: id, kind: 'chat', title: text(body.title, 'Session title', 120), provider: provider.id, archived: false, createdAt: new Date().toISOString() };
        await this.load(record); this.records.push(record); this.selected = record.id;
      } else {
        if (body.definitionId !== undefined || body.agent !== undefined || body.useInstructionsOnly !== undefined) throw new DomainError('invalid_input', 'An agent definition is fixed when a task is created. Create a new task to change it.');
        const record = this.records.find(item => item.id === body.id); if (!record) throw new DomainError('not_found', 'Session not found');
        if (body.action === 'select') { record.archived = false; this.selected = record.id; }
        else if (body.action === 'rename') record.title = text(body.title, 'Session title', 120);
        else if (body.action === 'archive' || body.action === 'delete') {
          if (this.instances.get(record.id)?.snapshot().busy || this.executor.current === record.id || ['queued', 'running'].includes(record.taskState ?? '')) throw new DomainError('conflict', 'Stop the reply first.');
          const next = this.records.find(item => item.id !== record.id && !item.archived);
          if (record.id === this.selected && !next) throw new DomainError('conflict', 'Create another session before archiving the current one.');
          if (record.id === this.selected) this.selected = next!.id;
          if (body.action === 'archive') record.archived = true;
          else { if (this.protectedTasks.has(record.id)) throw new DomainError('conflict', 'Delete the linked local task from History before deleting its session.'); await this.instances.get(record.id)!.clear(); this.records = this.records.filter(item => item.id !== record.id); }
        } else throw new DomainError('invalid_input', 'Unknown session action');
      }
      await this.persist(); return this.view();
    } catch (error) { this.records = previous.records; this.selected = previous.selected; throw error; }
    finally { this.changing = false; }
  }
  async close() { await Promise.all([...this.instances.values()].map(item => item.close())); }
}
