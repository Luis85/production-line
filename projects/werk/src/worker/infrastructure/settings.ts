import { defaultConsumptionPolicy, validateConsumptionPolicy, type ConsumptionPolicy } from '../application/consumption.js';
import type { WorkerSettingsView } from '../application/workspace-view.js';
import { defaultToolPolicy, discoveredToolPolicy, publicToolPolicy, updateToolPolicy, validateToolPolicy, type ToolPolicy } from '../application/tool-policy.js';
import { defaultRepositoryConfiguration, validateRepositoryConfiguration, type RepositoryConfiguration } from '../application/repositories.js';
import { defaultResourcePolicy, validateResourcePolicy, type ResourcePolicy } from '../application/resources.js';
import { defaultExecutionPolicy, validateExecutionPolicy, type ExecutionPolicy } from '../application/execution-policy.js';
import { join, isAbsolute, resolve } from 'node:path';
import { object, text } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import { atomicWrite, readBoundedFile } from './journal/files.js';
import { findExecutable, providerIds, providerLabels, providerReady, type ProviderConnection, type ProviderId } from './providers.js';
export interface WorkspaceSettings {
  repositories: RepositoryConfiguration;
  resources: ResourcePolicy;
  execution: ExecutionPolicy;
  consumption: ConsumptionPolicy;
  providers: ProviderConnection[];
  connection: { enabled: boolean; url: string; enrollmentToken: string };
  board: { paused: boolean; maxParallel: number; queueCapacity: number; orchestratorQueue: number; order: 'fifo' | 'priority' };
}
export class WorkerSettings {
  private directory: string;
  value: WorkspaceSettings;
  private writing = Promise.resolve();
  private tools: ToolPolicy = defaultToolPolicy();
  private executionOverride?: ExecutionPolicy;
  private savedExecution = defaultExecutionPolicy();
  private executionSource: 'environment' | 'saved_settings' | 'default' = 'default';
  constructor(directory: string, url = '', enrollmentToken = '', executable = '', repositories = defaultRepositoryConfiguration()) {
    this.directory = directory;
    this.value = { repositories: validateRepositoryConfiguration(repositories), resources: defaultResourcePolicy(), execution: defaultExecutionPolicy(), consumption: defaultConsumptionPolicy(), providers: providerIds.map(id => ({ id, executable: id === 'codex-cli' ? executable : '', model: '', apiKey: '' })), connection: { enabled: !!url, url, enrollmentToken }, board: { paused: false, maxParallel: 1, queueCapacity: 16, orchestratorQueue: 0, order: 'fifo' } };
  }
  async init() {
    const configured = process.env.WERK_WORKER_MAX_RUNTIME_MS;
    if (configured !== undefined) this.executionOverride = validateExecutionPolicy({ maxRuntimeMs: /^\d+$/.test(configured) ? Number(configured) : NaN });
    try { const saved = JSON.parse(await readBoundedFile(join(this.directory, 'workspace-settings.json'), 65536)); if (saved?.board) saved.board.maxParallel = 1; if (saved?.execution !== undefined) this.executionSource = 'saved_settings'; this.value = this.validate(saved); this.savedExecution = { ...this.value.execution }; await this.persist(this.value); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      for (const provider of this.value.providers) if (provider.id.endsWith('-cli') && !provider.executable) provider.executable = await findExecutable(provider.id === 'codex-cli' ? 'codex' : 'claude');
      this.value = this.validate(this.value); await this.persist(this.value);
    }
    if (this.executionOverride) { this.value.execution = { ...this.executionOverride }; this.executionSource = 'environment'; }
    try { this.tools = validateToolPolicy(JSON.parse(await readBoundedFile(join(this.directory, 'tool-access.json'), 655360))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  }
  toolPolicy(): ToolPolicy { return structuredClone(this.tools); }
  toolAccess() { return publicToolPolicy(this.tools); }
  async updateToolAccess(input: unknown) {
    return this.saveToolPolicy(previous => updateToolPolicy(previous, input));
  }
  async discoveredTools(id: string, expectedRevision: number, tools: unknown) {
    return this.saveToolPolicy(previous => discoveredToolPolicy(previous, id, expectedRevision, tools));
  }
  private async saveToolPolicy(change: (previous: ToolPolicy) => ToolPolicy) {
    const operation = this.writing.catch(() => {}).then(async () => {
      const next = change(this.tools), document = JSON.stringify(next) + '\n';
      if (Buffer.byteLength(document) > 655360) throw new DomainError('invalid_input', 'Tool configuration exceeds 640 KiB. Use fewer connections or smaller tool catalogs.');
      await atomicWrite(join(this.directory, 'tool-access.json'), document);
      this.tools = next;
    });
    this.writing = operation; await operation; return this.toolAccess();
  }
  publicView(): WorkerSettingsView { return { repositories: structuredClone(this.value.repositories), executionSource: this.executionSource, resources: { ...this.value.resources }, consumption: { ...this.value.consumption }, execution: { ...this.value.execution }, providers: this.value.providers.map(({ apiKey, ...provider }) => ({ ...provider, label: providerLabels[provider.id], configured: providerReady({ ...provider, apiKey }), hasApiKey: !!apiKey, authentication: provider.id.endsWith('-cli') ? 'Host CLI login; not verified' : 'Private API key' })), connection: { enabled: this.value.connection.enabled, url: this.value.connection.url, hasEnrollmentToken: !!this.value.connection.enrollmentToken }, board: { ...this.value.board } }; }
  provider(id: string) { const value = this.value.providers.find(item => item.id === id); if (!value) throw new DomainError('invalid_input', 'Choose a supported provider.'); return value; }
  async update(input: unknown) {
    const operation = this.writing.catch(() => {}).then(async () => {
      const body = object(input, 'Settings', ['provider', 'connection', 'board', 'resources', 'execution', 'repositories', 'consumption', 'expectedConsumption', 'expectedBoard', 'expectedDuration']);
      if (body.execution !== undefined && this.executionOverride) throw new DomainError('conflict', 'WERK_WORKER_MAX_RUNTIME_MS controls this worker. Change or remove that environment override and restart before editing the execution limit.');
      if (body.expectedConsumption !== undefined) {
        if (body.consumption === undefined) throw new DomainError('invalid_input', 'A consumption baseline requires a new consumption policy.');
        const expected = validateConsumptionPolicy(body.expectedConsumption);
        if ((Object.keys(expected) as Array<keyof ConsumptionPolicy>).some(key => expected[key] !== this.value.consumption[key]))
          throw new DomainError('conflict', 'Consumption limits changed in another session. Reload the current limits before saving.');
      }
      if (body.expectedBoard !== undefined) {
        if (body.board === undefined) throw new DomainError('invalid_input', 'A queue baseline requires queue settings to save.');
        const fields = ['queueCapacity', 'orchestratorQueue', 'order'] as const;
        // Pause is an independent operational action, never part of a queue editor's stale snapshot.
        const patch = object(body.board, 'Queue settings', [...fields]);
        if (!fields.some(key => patch[key] !== undefined)) throw new DomainError('invalid_input', 'A queue baseline requires queue settings to save.');
        const expected = object(body.expectedBoard, 'Queue settings baseline', [...fields]);
        if (fields.some(key => expected[key] === undefined)) throw new DomainError('invalid_input', 'Use the complete queue settings baseline before saving.');
        this.validateBoard({ ...this.value.board, ...expected });
        if (fields.some(key => expected[key] !== this.value.board[key]))
          throw new DomainError('conflict', 'Queue settings changed in another session. Reload the current queue settings before saving.');
      }
      if (body.expectedDuration !== undefined) {
        const resources = body.resources === undefined ? undefined : object(body.resources, 'Resources', Object.keys(defaultResourcePolicy()));
        if (body.execution === undefined && resources?.longRunningMs === undefined) throw new DomainError('invalid_input', 'A duration baseline requires an execution limit or long-running warning to save.');
        const expected = object(body.expectedDuration, 'Duration baseline', ['maxRuntimeMs', 'longRunningMs']);
        const execution = validateExecutionPolicy({ maxRuntimeMs: expected.maxRuntimeMs });
        const warning = validateResourcePolicy({ ...defaultResourcePolicy(), longRunningMs: expected.longRunningMs });
        if (execution.maxRuntimeMs !== this.value.execution.maxRuntimeMs || warning.longRunningMs !== this.value.resources.longRunningMs)
          throw new DomainError('conflict', 'Duration settings changed in another session. Reload the current duration settings before saving.');
      }
      const next = structuredClone(this.value);
      if (body.consumption !== undefined) next.consumption = validateConsumptionPolicy(body.consumption);
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
      if (body.repositories !== undefined) next.repositories = validateRepositoryConfiguration(body.repositories, path => { if (!isAbsolute(path)) throw new DomainError('invalid_input', 'Repository path must be absolute on the worker machine.'); return resolve(path); });
      if (body.resources !== undefined) next.resources = { ...next.resources, ...object(body.resources, 'Resources', Object.keys(defaultResourcePolicy())) };
      if (body.execution !== undefined) next.execution = { ...next.execution, ...object(body.execution, 'Execution', ['maxRuntimeMs']) };
      const validated = this.validate(next); await this.persist(validated); this.value = validated;
      if (body.execution !== undefined) { this.savedExecution = { ...validated.execution }; this.executionSource = 'saved_settings'; }
    });
    this.writing = operation; await operation; return this.publicView();
  }
  private persist(value: WorkspaceSettings) {
    const document = JSON.stringify(this.executionOverride ? { ...value, execution: this.savedExecution } : value) + '\n';
    if (Buffer.byteLength(document) > 65536) throw new DomainError('invalid_input', 'Worker settings limit: 64 KiB. Use fewer or shorter repository assignments.');
    return atomicWrite(join(this.directory, 'workspace-settings.json'), document);
  }
  private validate(value: WorkspaceSettings): WorkspaceSettings {
    if (!value || !Array.isArray(value.providers) || value.providers.length !== 4 || new Set(value.providers.map(item => item.id)).size !== 4) throw new DomainError('invalid_input', 'Invalid provider configuration');
    for (const p of value.providers) {
      if (!providerIds.includes(p.id as ProviderId) || typeof p.executable !== 'string' || (p.executable && (!isAbsolute(p.executable) || /[\x00-\x1f]/.test(p.executable))) || p.executable.length > 4096 || typeof p.model !== 'string' || p.model.length > 200 || typeof p.apiKey !== 'string' || p.apiKey.length > 4096 || /[\r\n]/.test(p.apiKey)) throw new DomainError('invalid_input', 'Use an absolute CLI path and valid model/key.');
    }
    value.repositories = validateRepositoryConfiguration(value.repositories === undefined ? this.value.repositories : value.repositories);
    value.consumption = validateConsumptionPolicy(value.consumption ?? defaultConsumptionPolicy());
    value.resources = validateResourcePolicy(value.resources ?? defaultResourcePolicy());
    value.execution = validateExecutionPolicy(value.execution ?? defaultExecutionPolicy());
    const c = value.connection;
    if (!c || typeof c.enabled !== 'boolean' || typeof c.url !== 'string' || typeof c.enrollmentToken !== 'string' || c.enrollmentToken.length > 4096 || /[\r\n]/.test(c.enrollmentToken)) throw new DomainError('invalid_input', 'Invalid orchestrator connection');
    if (c.url || c.enabled) { let url; try { url = new URL(c.url); } catch { throw new DomainError('invalid_input', 'Enter an orchestrator HTTP(S) address.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new DomainError('invalid_input', 'Use an HTTP(S) origin without credentials or a path.');
      c.url = url.origin;
    }
    this.validateBoard(value.board);
    return value;
  }
  private validateBoard(b: WorkspaceSettings['board']) {
    if (!b || typeof b.paused !== 'boolean' || !['fifo', 'priority'].includes(b.order) || !Number.isInteger(b.maxParallel) || b.maxParallel !== 1 || !Number.isInteger(b.queueCapacity) || b.queueCapacity < 1 || b.queueCapacity > 64 || !Number.isInteger(b.orchestratorQueue) || b.orchestratorQueue < 0 || b.orchestratorQueue > 64) throw new DomainError('invalid_input', 'Workers execute one task at a time; local queue: 1–64; orchestrator queue: 0–64.');
  }
}
