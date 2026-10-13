import { definitionConnection } from '../application/definitions.js';
import { WorkerSettings } from '../infrastructure/settings.js';
import { WorkerSessions } from '../application/sessions.js';
import { LocalTaskboard } from '../application/local-tasks.js';
import { TaskIndex } from '../infrastructure/task-index.js';
import { object, text, identifier, type Task } from '../../shared/contracts.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join, resolve, isAbsolute } from 'node:path';
import { opendir, statfs } from 'node:fs/promises';
import { availableParallelism, freemem, totalmem, hostname, release, loadavg } from 'node:os';
import { DomainError } from '../../shared/errors.js';
import { atomicWrite, ensureDirectory, readBoundedFile } from '../infrastructure/journal/files.js';
import type { SnapshotJournal } from '../infrastructure/journal/snapshots.js';
import type { Status } from './server.js';
export function chatConfiguration(value: unknown): string | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('invalid_input', 'chat must contain codexExecutable');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== 1 || typeof raw.codexExecutable !== 'string' || !isAbsolute(raw.codexExecutable) || raw.codexExecutable.length > 4096 || /[\x00-\x1f\x7f]/.test(raw.codexExecutable)) throw new DomainError('invalid_input', 'chat.codexExecutable must be an absolute path');
  if (process.platform !== 'linux') throw new DomainError('invalid_input', 'Codex chat currently requires native Linux');
  return raw.codexExecutable;
}
export class WorkerWorkspace {
  private taskIndex: TaskIndex;
  readonly settings: WorkerSettings; readonly sessions: WorkerSessions; readonly board: LocalTaskboard;
  get accessScope() { return createHash('sha256').update(this.token).digest('hex').slice(0, 16); }
  get definitions() { return this.sessions.definitions; }
  get chat() { return this.sessions.chat; }
  get executor() { return this.sessions.executor; }
  async startChat(message: unknown) {
    if (this.sessions.chatActive + this.board.active >= this.settings.value.board.queueCapacity) throw new DomainError('conflict', 'Worker task queue is full.');
    return this.sessions.start(message);
  }
  private taskRequests = Promise.resolve();
  private acceptingTasks = true;
  /** Address sessions directly; automation never changes the browser's selected task. */
  async task(input: unknown) {
    const operation = this.taskRequests.catch(() => {}).then(async () => {
      if (!this.acceptingTasks) throw new DomainError('unavailable', 'Worker is stopping.');
      const body = object(input, 'Task command', ['action', 'id', 'title', 'provider', 'message', 'definitionId', 'agent', 'useInstructionsOnly']);
      if (!['create', 'get', 'send', 'cancel'].includes(String(body.action))) throw new DomainError('invalid_input', 'Task action: create|get|send|cancel');
      if (body.action !== 'create' && (body.definitionId !== undefined || body.agent !== undefined || body.useInstructionsOnly !== undefined)) throw new DomainError('invalid_input', 'An agent definition is fixed when a task is created.');
      const id = body.action === 'create' && body.id === undefined ? randomUUID() : identifier(body.id, 'id');
      if (body.action === 'get') return this.sessions.detail(id);
      if (body.action === 'cancel') return this.sessions.cancelTask(id);
      const message = text(body.message, 'message', 8000);
      if (body.action === 'create') {
        const title = text(body.title, 'title', 120), provider = this.settings.provider(String(body.provider));
        const existing = this.sessions.view().records.find(item => item.id === id);
        const savedDefinition = existing?.definition;
        const definition = savedDefinition && body.definitionId === savedDefinition.definitionId && (body.agent ?? 'root') === savedDefinition.agent && (!savedDefinition.adapted || body.useInstructionsOnly === true) ? savedDefinition : this.definitions.select(body);
        definitionConnection(provider, definition);
        const submissionHash = createHash('sha256').update(JSON.stringify({ title, provider: provider.id, message, ...(definition ? { definition } : {}) })).digest('hex');
        if (existing) {
          const detail = this.sessions.detail(id);
          if (existing.kind !== 'chat' || existing.submissionHash !== submissionHash) throw new DomainError('conflict', 'Task id already belongs to different input.');
          if (detail.chat.messages.length > 0) return detail;
        }
        if (this.sessions.chatActive + this.board.active >= this.settings.value.board.queueCapacity) throw new DomainError('conflict', 'Worker task queue is full.');
        await this.sessions.ensureTask(id, 'chat', title, provider.id, submissionHash, definition);
      }
      if (this.sessions.chatActive + this.board.active >= this.settings.value.board.queueCapacity) throw new DomainError('conflict', 'Worker task queue is full.');
      await this.sessions.start(message, id);
      return this.sessions.detail(id);
    });
    this.taskRequests = operation.then(() => {}, () => {});
    return operation;
  }
  private token = '';
  private historyCache?: { at: number; value: Awaited<ReturnType<WorkerWorkspace['readHistory']>> };
  private historyReading?: ReturnType<WorkerWorkspace['readHistory']>;
  private config: { stateDir: string; url?: string; enrollmentToken?: string; projectDir?: string; chatExecutable?: string; retainedPairs?: number; pollMs: number; timeoutMs: number }; private journal: SnapshotJournal; private get: () => Status;
  constructor(config: { stateDir: string; url?: string; enrollmentToken?: string; projectDir?: string; chatExecutable?: string; retainedPairs?: number; pollMs: number; timeoutMs: number }, journal: SnapshotJournal, get: () => Status) {
    this.taskIndex = new TaskIndex(config.stateDir);
    this.config = config; this.journal = journal; this.get = get;
    this.settings = new WorkerSettings(config.stateDir, config.url, config.enrollmentToken, config.chatExecutable);
    this.sessions = new WorkerSessions(config.stateDir, this.settings); this.board = new LocalTaskboard(config.stateDir, this.settings, this.sessions);
  }
  async init() {
    await ensureDirectory(this.config.stateDir);
    try { this.token = (await readBoundedFile(join(this.config.stateDir, 'webview-token'), 128)).trim(); if (!/^[a-f0-9]{64}$/.test(this.token)) throw Error('Invalid worker webview token'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.token = randomBytes(32).toString('hex'); await atomicWrite(join(this.config.stateDir, 'webview-token'), this.token + '\n'); }
    await this.settings.init(); await this.sessions.init(); await this.board.init();
    await this.taskIndex.init();
  }
  async updateSettings(body: unknown) {
    const input = body as Record<string, unknown>;
    if (input?.provider && (this.sessions.busy || this.board.active)) throw new DomainError('conflict', 'Finish or stop queued tasks and active replies before changing providers.');
    if (input?.connection && (this.get().activeTasks.length || this.get().queuedTasks?.length)) throw new DomainError('conflict', 'Pause intake and drain orchestrator assignments before changing the connection.');
    if (input?.connection) {
      const connection = input.connection as Record<string, unknown>;
      try { const identity = JSON.parse(await readBoundedFile(join(this.config.stateDir, 'identity.json'), 16384));
        if (connection.url && new URL(String(connection.url)).origin !== new URL(identity.url).origin) throw new DomainError('conflict', 'This identity is bound to another orchestrator. Use a separate worker state directory for another server.');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const result = await this.settings.update(body); if (input?.provider) await this.sessions.reloadProviders(); return result;
  }
  async close() { this.acceptingTasks = false; await this.taskRequests; await this.board.close(); await this.sessions.close(); }
  async rememberTask(task: Task) { await this.taskIndex.remember(task); await this.sessions.ensureTask('remote-' + task.id, 'orchestrator', task.title, task.provider === 'claude' ? 'claude-cli' : 'codex-cli'); this.historyCache = undefined; }
  authenticate(token: string) { const supplied = Buffer.from(token); if (supplied.length !== 64 || !timingSafeEqual(supplied, Buffer.from(this.token))) throw new DomainError('unauthorized', 'Worker access token is incorrect.'); }
  async environment() {
    const memory = process.memoryUsage(), disk = await statfs(this.config.stateDir).catch(() => null);
    const connection = this.settings.value.connection;
    const address = connection.url ? new URL(connection.url) : null; if (address) { address.username = ''; address.password = ''; address.search = ''; address.hash = ''; }
    return { capturedAt: new Date().toISOString(), hostname: hostname(), platform: process.platform, osRelease: release(), architecture: process.arch, nodeVersion: process.version, pid: process.pid, uptimeSeconds: process.uptime(), logicalCpus: availableParallelism(), hostLoad: process.platform === 'win32' ? null : loadavg(), memory: { processRssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, hostFreeBytes: freemem(), hostTotalBytes: totalmem() }, disk: disk ? { freeBytes: disk.bavail * disk.bsize, totalBytes: disk.blocks * disk.bsize } : null, stateDirectory: resolve(this.config.stateDir), projectDirectory: this.config.projectDir ? resolve(this.config.projectDir) : null, orchestratorUrl: address?.toString() ?? null, pollMs: this.config.pollMs, taskTimeoutMs: this.config.timeoutMs, retainedPairs: this.config.retainedPairs ?? 1000, chat: { configured: this.chat.snapshot().available, provider: this.sessions.current.provider, authentication: this.sessions.current.provider.endsWith('-cli') ? 'Host CLI sign-in; use Check sign-in to verify' : 'Private API key; use Check connection to verify', timeoutSeconds: 120 }, status: this.get() };
  }
  async history() {
    if (this.historyCache && Date.now() - this.historyCache.at < 5000) return this.historyCache.value;
    this.historyReading ??= this.readHistory().then(value => { this.historyCache = { at: Date.now(), value }; return value; }).finally(() => { this.historyReading = undefined; });
    return this.historyReading;
  }
  private async readHistory() {
    const rows = []; let inspected = 0, unreadable = 0, limited = false;
    const active = new Set(this.get().activeTasks.map(task => task.id + ':' + task.attempt));
    const directory = await opendir(join(this.config.stateDir, 'snapshots'));
    for await (const entry of directory) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,100}$/.test(entry.name)) continue;
      if (inspected++ >= 1000) { limited = true; break; }
      try {
        const after = await this.journal.read(entry.name, 'after'), before = await this.journal.read(entry.name, 'before'), snapshot = after ?? before;
        if (!snapshot) continue;
        rows.push({ title: this.taskIndex.title(snapshot.taskId), pairId: snapshot.pairId, taskId: snapshot.taskId, attempt: snapshot.attempt, project: snapshot.project, provider: snapshot.provider, profile: snapshot.profileId, mode: snapshot.mode, startedAt: before?.capturedAt ?? null, finishedAt: after?.capturedAt ?? null, outcome: after?.execution.outcome ?? (active.has(snapshot.taskId + ':' + snapshot.attempt) ? 'running' : 'incomplete'), durationMs: after?.execution.durationMs ?? null, error: after?.execution.error ?? null, resources: snapshot.resources, usage: snapshot.usage, quality: snapshot.quality, provenance: snapshot.provenance, review: after?.review ?? null, completePair: !!before && !!after });
      } catch { unreadable++; }
    }
    rows.sort((a, b) => (b.startedAt ?? b.finishedAt ?? '').localeCompare(a.startedAt ?? a.finishedAt ?? '') || a.pairId.localeCompare(b.pairId));
    return { rows, limited, unreadable, capturedAt: new Date().toISOString(), retainedPairs: this.config.retainedPairs ?? 1000 };
  }
}
