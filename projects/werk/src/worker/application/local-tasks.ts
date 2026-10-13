import { definitionConnection, type DefinitionSnapshot } from './definitions.js';
import { randomUUID, createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
import { realpath, lstat } from 'node:fs/promises';
import { object, text } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import { atomicWrite, ensureDirectory, readBoundedFile } from '../infrastructure/journal/files.js';
import { codexConfiguration } from '../infrastructure/codex-adapter.js';
import { modelFor, type ProviderId } from '../infrastructure/providers.js';
import type { WorkerSettings } from '../infrastructure/settings.js';
import type { WorkerSessions } from './sessions.js';
import type { ConversationModel } from './conversation.js';
export interface TaskFile { path: string; content: string; existed: boolean; }
export interface LocalTask { definition?: DefinitionSnapshot; id: string; title: string; instruction: string; sessionId: string; provider: ProviderId; model: string; repository: string; files: TaskFile[]; status: 'queued' | 'running' | 'review' | 'failed' | 'cancelled'; priority: number; createdAt: string; finishedAt: string | null; error: string | null; summary: string | null; patch: string | null; archived: boolean; }
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
function patchFile(file: TaskFile, content: string) {
  if (file.content === content && file.existed) return '';
  const lines = (value: string, prefix: string) => !value ? '' : value.split('\n').slice(0, value.endsWith('\n') ? -1 : undefined).map((line, index, all) => prefix + line + '\n' + (index === all.length - 1 && !value.endsWith('\n') ? '\\ No newline at end of file\n' : '')).join('');
  const count = (value: string) => value ? value.split('\n').length - (value.endsWith('\n') ? 1 : 0) : 0;
  const oldCount = count(file.content), newCount = count(content);
  return `diff --git ${JSON.stringify('a/' + file.path)} ${JSON.stringify('b/' + file.path)}\n${file.existed ? '' : 'new file mode 100644\n'}--- ${file.existed ? JSON.stringify('a/' + file.path) : '/dev/null'}\n+++ ${JSON.stringify('b/' + file.path)}\n@@ -${oldCount ? 1 : 0},${oldCount} +${newCount ? 1 : 0},${newCount} @@\n${lines(file.content, '-')}${lines(content, '+')}`;
}
/** Explicit tasks generate bounded, reviewable patches; provider output is never executed as shell code. */
export class LocalTaskboard {
  private directory: string; private settings: WorkerSettings; private sessions: WorkerSessions;
  private tasks: LocalTask[] = []; private writing = Promise.resolve(); private running = new Map<string, { controller: AbortController; promise: Promise<void> }>(); private closed = false; private persistenceError = false;
  private model: typeof modelFor;
  constructor(directory: string, settings: WorkerSettings, sessions: WorkerSessions, model: typeof modelFor = modelFor) { this.directory = directory; this.settings = settings; this.sessions = sessions; this.model = model; }
  async init() {
    try { const value = JSON.parse(await readBoundedFile(join(this.directory, 'taskboard.json'), 16777216));
      if (!Array.isArray(value) || value.length > 100 || value.some(task => !task || !/^[a-z0-9-]+$/.test(task.id) || !['queued', 'running', 'review', 'failed', 'cancelled'].includes(task.status) || !Array.isArray(task.files))) throw Error('Invalid taskboard');
      this.tasks = value;
      for (const task of this.tasks) if (task.status === 'running') { task.status = 'failed'; task.error = 'Worker stopped during execution. Review the attempt, then retry explicitly.'; task.finishedAt = new Date().toISOString(); }
      for (const task of this.tasks) {
        task.sessionId = 'local-' + task.id;
        const previous = this.sessions.view().records.find(record => record.id === task.sessionId);
        await this.sessions.ensureTask(task.sessionId, 'local', task.title, task.provider, undefined, task.definition);
        this.sessions.protectTask(task.sessionId, true);
        if (!previous || previous.taskState !== undefined || task.status === 'queued') await this.sessions.setTaskState(task.sessionId, task.status === 'review' ? 'completed' : task.status);
      }
      await this.persist(this.tasks);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const record of this.sessions.view().records) if (record.kind === 'local' && ['queued', 'running'].includes(record.status) && !this.tasks.some(task => task.sessionId === record.id)) await this.sessions.setTaskState(record.id, 'failed');
  }
  private input(task: LocalTask) { return task.instruction + '\nApproved paths: ' + task.files.map(file => file.path).join(', '); }
  get active() { return this.tasks.filter(task => ['queued', 'running'].includes(task.status)).length; }
  view() { return { settings: { ...this.settings.value.board }, tasks: this.tasks.map(({ files, instruction, patch, ...task }) => ({ ...task, files: files.map(file => ({ path: file.path, sha256: fingerprint(file.content) })), hasPatch: !!patch })), persistenceError: this.persistenceError, running: this.tasks.filter(task => task.status === 'running').length }; }
  detail(id: string) { const task = this.tasks.find(item => item.id === id); if (!task) throw new DomainError('not_found', 'Task not found'); return structuredClone(task); }
  private async persist(tasks: LocalTask[]) { const body = JSON.stringify(tasks); if (Buffer.byteLength(body) > 16777216) throw new DomainError('conflict', 'Taskboard storage is full. Delete old tasks to free space.'); await atomicWrite(join(this.directory, 'taskboard.json'), body); this.persistenceError = false; }
  private change(operation: (tasks: LocalTask[]) => void | Promise<void>) {
    const write = this.writing.catch(() => {}).then(async () => { const next = structuredClone(this.tasks); await operation(next); const changed = next.filter(task => this.tasks.find(item => item.id === task.id)?.status !== task.status); await this.persist(next); for (const task of this.tasks) if (!next.some(item => item.id === task.id)) this.sessions.protectTask(task.sessionId, false); this.tasks = next; for (const task of changed) await this.sessions.setTaskState(task.sessionId, task.status === 'review' ? 'completed' : task.status); }); this.writing = write; return write;
  }
  async create(input: unknown) {
    if (this.closed) throw new DomainError('unavailable', 'Worker is stopping');
    const body = object(input, 'Local task', ['title', 'instruction', 'repository', 'paths', 'priority', 'provider', 'definitionId', 'agent', 'useInstructionsOnly']);
    const title = text(body.title, 'Title', 200), instruction = text(body.instruction, 'Instruction', 8000);
    const definition = this.sessions.definitions.select(body);
    const provider = definitionConnection(this.settings.provider(body.provider === undefined ? this.sessions.current.provider : String(body.provider)), definition);
    if (!this.model(provider, this.directory)) throw new DomainError('invalid_input', 'Configure this session’s provider before running a task.');
    const config = codexConfiguration({ executable: resolve('provider'), repository: body.repository, allowedPaths: body.paths });
    const repository = await realpath(config.repository), files: TaskFile[] = [];
    let bytes = 0;
    for (const path of config.allowedPaths) {
      const parts = path.split('/');
      for (let i = 1; i <= parts.length; i++) { const entry = join(repository, ...parts.slice(0, i)); const info = await lstat(entry).catch(error => { if (error.code !== 'ENOENT') throw error; return null; }); if (info?.isSymbolicLink() || (info && i < parts.length && !info.isDirectory())) throw new DomainError('invalid_input', 'Approved files cannot contain symlinks.'); }
      const absolute = resolve(repository, path); if (relative(repository, absolute).startsWith('..')) throw new DomainError('invalid_input', 'File outside repository');
      let content = '', existed = true;
      try { content = await readBoundedFile(absolute, 24000); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; existed = false; }
      bytes += content.length; if (bytes > 48000 || content.includes('\0')) throw new DomainError('invalid_input', 'Task input must be text, at most 48,000 characters in total.');
      files.push({ path, content, existed });
    }
    if (body.priority !== undefined && body.priority !== 1 && body.priority !== 2) throw new DomainError('invalid_input', 'Priority must be 1 or 2');
    const id = randomUUID();
    const task: LocalTask = { ...(definition ? { definition } : {}), id, title, instruction, sessionId: 'local-' + id, provider: provider.id, model: provider.model, repository, files, status: 'queued', priority: Number(body.priority ?? 1), createdAt: new Date().toISOString(), finishedAt: null, error: null, summary: null, patch: null, archived: false };
    try { await this.change(async tasks => { if (tasks.length >= 100) throw new DomainError('conflict', 'Taskboard holds 100 tasks. Delete an old task first.'); if (tasks.filter(item => ['queued', 'running'].includes(item.status)).length + this.sessions.chatActive >= this.settings.value.board.queueCapacity) throw new DomainError('conflict', 'Local task queue is full.'); await this.sessions.ensureTask(task.sessionId, 'local', task.title, task.provider, undefined, task.definition); this.sessions.protectTask(task.sessionId, true); await this.sessions.prepareTask(task.sessionId, this.input(task)); tasks.push(task); }); }
    catch (error) { if (!this.tasks.some(item => item.id === id)) { this.sessions.protectTask(task.sessionId, false); await this.sessions.setTaskState(task.sessionId, 'failed').catch(() => {}); } throw error; }
    return this.view();
  }
  async action(input: unknown) {
    const body = object(input, 'Task action', ['id', 'action', 'priority']); const id = String(body.id);
    if (body.action === 'cancel') this.running.get(id)?.controller.abort();
    await this.change(async tasks => {
      const task = tasks.find(item => item.id === id); if (!task) throw new DomainError('not_found', 'Task not found');
      if (body.action === 'cancel') { if (task.status === 'queued') { task.status = 'cancelled'; task.finishedAt = new Date().toISOString(); await this.sessions.recordTask(task.sessionId, this.input(task), 'Task cancelled before execution.', true); } else if (task.status !== 'running') throw new DomainError('conflict', 'Task is no longer active'); }
      else if (body.action === 'priority') { if (task.status !== 'queued' || ![1, 2].includes(Number(body.priority))) throw new DomainError('invalid_input', 'Only queued tasks can change priority (1 or 2)'); task.priority = Number(body.priority); }
      else if (body.action === 'retry') { if (!['failed', 'cancelled'].includes(task.status) || this.running.has(id) || this.sessions.view().records.find(record => record.id === task.sessionId)?.busy) throw new DomainError('conflict', 'Only stopped or failed tasks can be retried'); if (tasks.filter(item => ['queued', 'running'].includes(item.status)).length >= this.settings.value.board.queueCapacity) throw new DomainError('conflict', 'Queue is full'); await this.sessions.setTaskState(task.sessionId, 'queued'); task.status = 'queued'; task.error = null; task.finishedAt = null; }
      else if (body.action === 'archive' || body.action === 'delete') { if (['running', 'queued'].includes(task.status)) throw new DomainError('conflict', 'Stop the task first'); if (body.action === 'archive') task.archived = !task.archived; else tasks.splice(tasks.indexOf(task), 1); }
      else throw new DomainError('invalid_input', 'Unknown task action');
    });
    return this.view();
  }
  async tick() {
    if (this.closed) return;
    this.sessions.executor.wake();
    if (this.settings.value.board.paused) return;
    const limit = 1;
    for (const task of this.tasks.filter(item => item.status === 'queued').sort((a, b) => (this.settings.value.board.order === 'priority' ? b.priority - a.priority : 0) || a.createdAt.localeCompare(b.createdAt))) {
      if (this.running.size >= limit || this.running.has(task.id)) break;
      const controller = new AbortController();
      const promise = this.sessions.executor.run(task.sessionId, controller.signal, () => this.execute(task.id, controller)).catch(() => {}).finally(() => this.running.delete(task.id));
      this.running.set(task.id, { controller, promise });
    }
  }
  private async execute(id: string, controller: AbortController) {
    try {
      await this.change(tasks => { const task = tasks.find(item => item.id === id)!; if (task.status !== 'queued') throw Error('Task no longer queued'); task.status = 'running'; });
      const task = this.detail(id); await this.sessions.ensureTask(task.sessionId, 'local', task.title, task.provider, undefined, task.definition);
      const connection = { ...this.settings.provider(task.provider), model: task.model };
      const model: ConversationModel | undefined = this.model(definitionConnection(connection, task.definition), this.directory); if (!model) throw Error('Provider not configured');
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
      const reply = await model.reply([{ id, role: 'user', state: 'complete', at: task.createdAt, text: `Implement the requested changes to the supplied files. Return ONLY a JSON object {"summary":"...","files":[{"path":"approved path","content":"complete new file content"}]}. Do not execute commands. Only include changed approved files. Do not claim tests were run. This creates a patch for human review.\nTask: ${task.title}\nInstruction: ${task.instruction}\nApproved file snapshots: ${JSON.stringify(task.files)}` }], signal);
      signal.throwIfAborted();
      if (reply.length > 64000) throw Error('Reply limit');
      const result = JSON.parse(reply.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
      if (typeof result.summary !== 'string' || result.summary.length > 2000 || !Array.isArray(result.files) || !result.files.length || result.files.length > task.files.length || new Set(result.files.map((item: any) => item.path)).size !== result.files.length) throw Error('Invalid change set');
      let patch = '';
      for (const change of result.files) { const before = task.files.find(file => file.path === change.path); if (!before || typeof change.content !== 'string' || change.content.length > 64000 || change.content.includes('\0')) throw Error('Invalid changed file'); patch += patchFile(before, change.content); }
      if (!patch || patch.length > 131072 || /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/.test(patch)) throw Error('Patch is empty, too large or contains sensitive material');
      await ensureDirectory(join(this.directory, 'local-review'));
      await atomicWrite(join(this.directory, 'local-review', id + '.patch'), patch);
      signal.throwIfAborted();
      await this.sessions.recordTask(task.sessionId, this.input(task), reply);
      await this.change(tasks => { Object.assign(tasks.find(item => item.id === id)!, { status: 'review', finishedAt: new Date().toISOString(), summary: result.summary, patch }); });
    } catch {
      const failed = this.tasks.find(task => task.id === id);
      if (failed?.status === 'running') await this.sessions.recordTask(failed.sessionId, this.input(failed), controller.signal.aborted ? 'Task stopped.' : 'Task could not produce a valid patch. Check provider settings and approved files before retrying.', true).catch(() => { this.persistenceError = true; });
      await this.change(tasks => { const task = tasks.find(item => item.id === id); if (task && task.status === 'running') Object.assign(task, { status: controller.signal.aborted ? 'cancelled' : 'failed', finishedAt: new Date().toISOString(), error: controller.signal.aborted ? 'Task stopped.' : 'Task could not produce a valid patch. Check provider settings and the approved file list, then retry.' }); }).catch(() => { this.persistenceError = true; /* Persisted running state recovers as interrupted on restart. */ });
    }
  }
  async close() { this.closed = true; for (const running of this.running.values()) running.controller.abort(); await Promise.allSettled([...this.running.values()].map(item => item.promise)); }
}
