import { join, isAbsolute } from 'node:path';
import { object, text } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import { atomicWrite, readBoundedFile } from './journal/files.js';
import { findExecutable, providerIds, providerLabels, providerReady, type ProviderConnection, type ProviderId } from './providers.js';
export interface WorkspaceSettings {
  providers: ProviderConnection[];
  connection: { enabled: boolean; url: string; enrollmentToken: string };
  board: { paused: boolean; maxParallel: number; queueCapacity: number; orchestratorQueue: number; order: 'fifo' | 'priority' };
}
export class WorkerSettings {
  private directory: string;
  value: WorkspaceSettings;
  private writing = Promise.resolve();
  constructor(directory: string, url = '', enrollmentToken = '', executable = '') {
    this.directory = directory;
    this.value = { providers: providerIds.map(id => ({ id, executable: id === 'codex-cli' ? executable : '', model: '', apiKey: '' })), connection: { enabled: !!url, url, enrollmentToken }, board: { paused: false, maxParallel: 1, queueCapacity: 16, orchestratorQueue: 0, order: 'fifo' } };
  }
  async init() {
    try { const saved = JSON.parse(await readBoundedFile(join(this.directory, 'workspace-settings.json'), 65536)); if (saved?.board) saved.board.maxParallel = 1; this.value = this.validate(saved); await this.persist(this.value); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      for (const provider of this.value.providers) if (provider.id.endsWith('-cli') && !provider.executable) provider.executable = await findExecutable(provider.id === 'codex-cli' ? 'codex' : 'claude');
      this.value = this.validate(this.value); await this.persist(this.value);
    }
  }
  publicView() { return { providers: this.value.providers.map(({ apiKey, ...provider }) => ({ ...provider, label: providerLabels[provider.id], configured: providerReady({ ...provider, apiKey }), hasApiKey: !!apiKey, authentication: provider.id.endsWith('-cli') ? 'Host CLI login; not verified' : 'Private API key' })), connection: { enabled: this.value.connection.enabled, url: this.value.connection.url, hasEnrollmentToken: !!this.value.connection.enrollmentToken }, board: { ...this.value.board } }; }
  provider(id: string) { const value = this.value.providers.find(item => item.id === id); if (!value) throw new DomainError('invalid_input', 'Choose a supported provider.'); return value; }
  async update(input: unknown) {
    const operation = this.writing.catch(() => {}).then(async () => {
      const body = object(input, 'Settings', ['provider', 'connection', 'board']);
      const next = structuredClone(this.value);
      if (body.provider) {
        const p = object(body.provider, 'Provider', ['id', 'executable', 'model', 'apiKey', 'clearApiKey']);
        const target = next.providers.find(item => item.id === p.id); if (!target) throw new DomainError('invalid_input', 'Unknown provider');
        if (p.executable !== undefined) target.executable = p.executable as string;
        if (p.model !== undefined) target.model = p.model as string;
        if (p.apiKey) target.apiKey = text(p.apiKey, 'API key', 4096);
        if (p.clearApiKey === true) target.apiKey = '';
      }
      if (body.connection) {
        const c = object(body.connection, 'Orchestrator', ['enabled', 'url', 'enrollmentToken']);
        if (c.enabled !== undefined) next.connection.enabled = c.enabled as boolean;
        if (c.url !== undefined) next.connection.url = c.url as string;
        if (c.enrollmentToken) next.connection.enrollmentToken = text(c.enrollmentToken, 'Enrollment token', 4096);
      }
      if (body.board) next.board = { ...next.board, ...object(body.board, 'Taskboard', ['paused', 'maxParallel', 'queueCapacity', 'orchestratorQueue', 'order']) };
      const validated = this.validate(next); await this.persist(validated); this.value = validated;
    });
    this.writing = operation; await operation; return this.publicView();
  }
  private persist(value: WorkspaceSettings) { return atomicWrite(join(this.directory, 'workspace-settings.json'), JSON.stringify(value) + '\n'); }
  private validate(value: WorkspaceSettings): WorkspaceSettings {
    if (!value || !Array.isArray(value.providers) || value.providers.length !== 4 || new Set(value.providers.map(item => item.id)).size !== 4) throw new DomainError('invalid_input', 'Invalid provider configuration');
    for (const p of value.providers) {
      if (!providerIds.includes(p.id as ProviderId) || typeof p.executable !== 'string' || (p.executable && (!isAbsolute(p.executable) || /[\x00-\x1f]/.test(p.executable))) || p.executable.length > 4096 || typeof p.model !== 'string' || p.model.length > 200 || typeof p.apiKey !== 'string' || p.apiKey.length > 4096 || /[\r\n]/.test(p.apiKey)) throw new DomainError('invalid_input', 'Use an absolute CLI path and valid model/key.');
    }
    const c = value.connection;
    if (!c || typeof c.enabled !== 'boolean' || typeof c.url !== 'string' || typeof c.enrollmentToken !== 'string' || c.enrollmentToken.length > 4096 || /[\r\n]/.test(c.enrollmentToken)) throw new DomainError('invalid_input', 'Invalid orchestrator connection');
    if (c.url || c.enabled) { let url; try { url = new URL(c.url); } catch { throw new DomainError('invalid_input', 'Enter an orchestrator HTTP(S) address.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new DomainError('invalid_input', 'Use an HTTP(S) origin without credentials or a path.');
      c.url = url.origin;
    }
    const b = value.board;
    if (!b || typeof b.paused !== 'boolean' || !['fifo', 'priority'].includes(b.order) || !Number.isInteger(b.maxParallel) || b.maxParallel !== 1 || !Number.isInteger(b.queueCapacity) || b.queueCapacity < 1 || b.queueCapacity > 64 || !Number.isInteger(b.orchestratorQueue) || b.orchestratorQueue < 0 || b.orchestratorQueue > 64) throw new DomainError('invalid_input', 'Workers execute one task at a time; local queue: 1–64; orchestrator queue: 0–64.');
    return value;
  }
}
