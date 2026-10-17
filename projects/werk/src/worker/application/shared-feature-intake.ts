import { sharedFeatureRequestReference } from './feature-request-reference.js';
import { publishSharedFeatureResponse } from './shared-feature-response.js';
import type { InteractionCommand } from './interactions.js';
import { SerializedOperations } from '../../shared/serialized-operations.js';
import { DomainError } from '../../shared/errors.js';
import { featureTaskDirectory, type FeatureWorkflowSnapshot } from './feature-workflow.js';
import { publishIntakeDiagnostic } from './intake-diagnostics.js';
import type { SharedFeatureView, SharedIntakeView, SharedIntakeNote } from './shared-intake-contract.js';
import { bindingKey, defaultSharedIntakeConfig, sharedTerminal, sharedTaskActive, validateSharedIntakeConfig, type SharedFeatureRecord, type SharedFeatureState, type SharedIntakePorts } from './shared-feature-state.js';
import { SharedFeatureLifecycle } from './shared-feature-lifecycle.js';
import { sharedHash } from './shared-feature-notes.js';

/** Git is the team intake. Local durable state owns dispatch and never substitutes for a remote claim. */
export class SharedFeatureIntake {
  private ports: SharedIntakePorts;
  private state: SharedFeatureState = { schemaVersion: 1, workerId: '', revision: 0, config: defaultSharedIntakeConfig(), records: [] };
  private lifecycle: SharedFeatureLifecycle;
  private discovered: SharedFeatureView[] = [];
  private snapshot: FeatureWorkflowSnapshot | null = null;
  private fault: string | null = null;
  private syncedAt: string | null = null;
  private syncing: Promise<void> | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = new AbortController();
  private initialized = false;
  private configuring = false;
  private responses = 0;
  private readonly configureWork = new SerializedOperations();
  constructor(ports: SharedIntakePorts) { this.ports = ports; this.lifecycle = new SharedFeatureLifecycle(ports, () => this.save()); }
  get enabled() { return this.initialized && this.state.config.enabled; }
  get busy() { return !!this.syncing || this.configuring || this.responses > 0; }
  requiredRepositoryIds(): string[] { return [...new Set([...(this.enabled ? [this.state.config.repositoryId] : []), ...this.state.records.filter(record => !sharedTerminal(record.status) || sharedTaskActive(record) || record.publication !== 'synced').map(record => record.binding.repositoryId)])]; }
  /** Retain provenance across binding changes without exposing request contents or credentials. */
  sourceForTask(taskId: string): { repositoryId: string; path: string } | undefined {
    const record = this.state.records.find(record => record.taskId === taskId);
    return record ? { repositoryId: record.binding.repositoryId, path: record.sourcePath } : undefined;
  }
  referenceForTask(taskId: string, existingKey?: string) {
    const record = this.state.records.find(record => record.taskId === taskId);
    if (!record) return undefined;
    const reference = sharedFeatureRequestReference(record);
    return record.submitted || reference.key === existingKey ? reference : undefined;
  }
  get binding() { return this.initialized ? structuredClone(this.state.config) : undefined; }
  async init() { this.state = await this.ports.load(); this.initialized = true; }
  start() { if (!this.timer && !this.stopping.signal.aborted) this.schedule(); }
  private schedule() {
    if (this.stopping.signal.aborted) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.sync().finally(() => this.schedule()); }, this.state.config.pollMs);
    this.timer.unref();
  }
  private save() { return this.ports.save(this.state); }
  view(blockedReason: string | null = null): SharedIntakeView {
    const workflow = this.snapshot;
    const locals = this.state.records.filter(record => bindingKey(record.binding) === bindingKey(this.state.config)).map(record => this.publicRecord(record));
    const known = new Set(locals.map(r => r.id));
    return {
      revision: this.state.revision, workerId: this.state.workerId, config: structuredClone(this.state.config),
      canEdit: !blockedReason && !this.busy, blockedReason: blockedReason ?? (this.busy ? 'Wait for shared synchronization to finish.' : null),
      state: !this.enabled ? 'disabled' : this.syncing || this.responses ? 'syncing' : this.fault ? 'error' : 'idle', error: this.fault,
      lastSyncedAt: this.syncedAt, sourceCommit: workflow?.commit ?? null,
      workflow: workflow ? { ...workflow.configuration, tasksDirectory: featureTaskDirectory(workflow.configuration), readyDigest: workflow.files.readyCheck.sha256, doneDigest: workflow.files.doneCheck.sha256 } : null,
      requests: [...locals, ...this.discovered.filter(r => !known.has(r.id)).map(record => ({ ...record, feature: sharedFeatureRequestReference({ id: record.id, sourcePath: (workflow?.configuration.requestsDirectory ?? 'features') + '/' + record.name, binding: this.state.config }) }))],
    };
  }
  private publicRecord(record: SharedFeatureRecord): SharedFeatureView {
    const { id, name, title, status, owner, sourceCommit, updatedAt, ready, done, featureBranch, reviewNote, taskNote, publication, error, taskId } = record;
    const task = record.task;
    const responseStatus = task?.response?.status;
    const taskResponse: SharedFeatureView['taskResponse'] = task && (task.uiResponse || task.response) ? {
      sessionId: task.identity.sessionId, expectedRevision: task.identity.expectedRevision, pendingId: task.identity.pendingId, turnId: task.identity.turnId,
      status: responseStatus === 'pending' ? 'ready' : responseStatus ?? (record.pending ? 'publication_pending' : 'ready'),
      error: (task.response?.error ?? record.error)?.slice(0, 500) ?? null,
    } : undefined;
    return structuredClone({ feature: sharedFeatureRequestReference(record), id, name, title, status, owner, isLocal: true, sourceCommit, updatedAt, ready, done, featureBranch, reviewNote, taskNote, publication, error, taskId, ...(taskResponse ? { taskResponse } : {}) });
  }
  async configure(value: unknown, expectedRevision: number) {
    const config = validateSharedIntakeConfig(value);
    if (this.syncing || this.responses) throw new DomainError('conflict', 'Wait for shared synchronization to finish.');
    await this.configureWork.run(async () => {
      if (this.stopping.signal.aborted) throw new DomainError('unavailable', 'Worker is stopping.');
      if (this.syncing || this.responses) throw new DomainError('conflict', 'Wait for shared synchronization to finish.');
      if (expectedRevision !== this.state.revision) throw new DomainError('conflict', 'Shared intake changed. Reload before saving.');
      if (bindingKey(config) !== bindingKey(this.state.config) && this.state.records.some(record => !sharedTerminal(record.status) || sharedTaskActive(record) || record.publication !== 'synced')) throw new DomainError('conflict', 'Finish the owned requests and publish their notes before changing the shared repository binding. Disable intake to pause it.');
      if (config.enabled) this.ports.repository(config);
      const previous = this.state;
      this.configuring = true;
      this.state = { ...previous, revision: previous.revision + 1, config };
      try { await this.save(); } catch (error) { this.state = previous; throw error; } finally { this.configuring = false; }
      if (bindingKey(config) !== bindingKey(previous.config)) { this.snapshot = null; this.discovered = []; this.syncedAt = null; }
      this.fault = null;
    });
  }
  async sync() {
    if ((!this.enabled && !this.state.records.length) || this.stopping.signal.aborted || this.configuring) return;
    if (this.syncing) return this.syncing;
    const run = this.configureWork.run(() => this.reconcile()).catch(error => { if (!this.stopping.signal.aborted) this.fault = error instanceof Error ? error.message.slice(0, 500) : 'Shared intake could not synchronize.'; }).finally(() => { this.syncing = null; });
    this.syncing = run;
    return run;
  }
  /** UI and Markdown responses share one serialized lifecycle and one dispatch consumer. */
  async respond(taskId: string, command: InteractionCommand) {
    if (this.stopping.signal.aborted || this.configuring) throw new DomainError('unavailable', 'Worker configuration is changing or the worker is stopping.');
    const response = structuredClone(command);
    this.responses++;
    try {
      return await this.configureWork.run(async () => {
        const record = this.state.records.find(item => item.taskId === taskId);
        if (!record?.claimed || !record.submitted) throw new DomainError('conflict', 'This Feature Request has no accepted shared execution.');
        const signal = this.stopping.signal;
        signal.throwIfAborted();
        await this.lifecycle.reconcile(record, signal);
        const repository = this.ports.repository(record.binding, record.workflow);
        await publishSharedFeatureResponse({ record, command: response, repository, signal,
          publish: artifacts => this.lifecycle.publish(record, repository, signal, artifacts) });
        await this.lifecycle.reconcile(record, signal);
        const interaction = this.ports.inspect(taskId)?.interaction;
        if (!interaction) throw new DomainError('unavailable', 'The response was published. Refresh the Feature Request to inspect its saved interaction.');
        return interaction;
      });
    } finally { this.responses--; }
  }
  private async reconcile() {
    const signal = this.stopping.signal, config = structuredClone(this.state.config);
    for (const record of this.state.records) {
      if (bindingKey(record.binding) !== bindingKey(config) && sharedTerminal(record.status) && !sharedTaskActive(record) && record.publication === 'synced') continue;
      await this.lifecycle.reconcile(record, signal);
    }
    if (!config.enabled) { this.fault = null; return; }
    const reader = this.ports.repository(config), commit = await reader.head(signal);
    const snapshot = await this.ports.loadWorkflow(reader, commit, config.workflowPath, signal);
    const repository = this.ports.repository(config, snapshot), files = await repository.listRequests(commit, signal);
    this.snapshot = snapshot;
    this.discovered = [];
    const ids = new Map<string, number>();
    const observed = files.map(file => { try { const source = this.ports.source(file); if (source.id) ids.set(source.id, (ids.get(source.id) ?? 0) + 1); return { file, source }; } catch { return { file, source: null }; } });
    const diagnosticErrors: string[] = [];
    const diagnostic = async (file: Parameters<typeof publishIntakeDiagnostic>[0]['file'], issues: string[]) => {
      try { return await publishIntakeDiagnostic({ repository, workflow: snapshot, file, owner: this.state.workerId, issues, signal }); }
      catch (error) {
        signal.throwIfAborted();
        diagnosticErrors.push(file.name + ': ' + (error instanceof Error ? error.message : 'Intake Task could not be published.'));
        return null;
      }
    };
    for (const { file, source } of observed) {
      signal.throwIfAborted();
      if (!source) { const issues = ['The request Markdown or frontmatter is invalid.']; const taskNote = await diagnostic(file, issues); this.discovered.push({ ...this.unclaimed(file.name, '', 'Invalid request', 'invalid', commit, issues), taskNote }); continue; }
      if (source.id && ids.get(source.id)! > 1) { const issues = ['Duplicate feature ID. Each request must have a unique stable ID.']; const taskNote = await diagnostic(file, issues); this.discovered.push({ ...this.unclaimed(file.name, source.id, source.title, 'invalid', commit, issues), taskNote }); continue; }
      if (source.shared) {
        if (!this.state.records.some(record => record.id === source.id && bindingKey(record.binding) === bindingKey(config))) {
          const own = source.shared.owner === this.state.workerId;
          this.discovered.push({ ...source.shared, isLocal: own, publication: 'synced', ...(own ? { status: 'blocked', error: 'This worker’s shared claim has no local journal. Restore its state; execution will not be repeated automatically.' } : {}) });
        }
        continue;
      }
      const existing = this.state.records.find(record => record.id === source.id && bindingKey(record.binding) === bindingKey(config));
      if (existing) continue;
      if (source.status !== 'ready') { this.discovered.push(this.unclaimed(file.name, source.id ?? '', source.title, source.status, commit)); continue; }
      const ready = this.ports.ready(file.content, snapshot);
      if (!ready.valid || !ready.input || !ready.inputHash) { const issues = ready.errors.map(e => e.message); const taskNote = await diagnostic(file, issues); this.discovered.push({ ...this.unclaimed(file.name, source.id ?? '', source.title, 'needs_rework', commit, issues), taskNote }); continue; }
      const issue = this.ports.admissionIssue?.(ready.input);
      if (issue) { const taskNote = await diagnostic(file, [issue]); this.discovered.push({ ...this.unclaimed(file.name, ready.input.id, ready.input.title, 'ready', commit, []), error: issue.slice(0, 500), taskNote }); continue; }
      await diagnostic(file, []);
      if (!this.ports.canAdmit()) { this.discovered.push(this.unclaimed(file.name, ready.input.id, ready.input.title, 'ready', commit, [])); continue; }
      if (this.state.records.length >= 100) throw new DomainError('conflict', 'Shared intake has reached 100 owned requests. Retain this worker state and configure another worker for further requests.');
      const at = new Date().toISOString();
      const record: SharedFeatureRecord = {
        id: ready.input.id, name: file.name, title: ready.input.title, status: 'queued', owner: this.state.workerId, isLocal: true, sourceCommit: commit, updatedAt: at,
        ready: { passed: true, issues: [] }, done: null, featureBranch: null, reviewNote: null, publication: 'pending', error: null,
        taskId: 'shared-feature-' + sharedHash(ready.input.id + bindingKey(config)).slice(0, 32),
        binding: config, sourcePath: file.path, sourceMarkdown: file.content, remoteRevision: file.revision,
        accepted: ready.input, inputHash: sharedHash(ready.inputHash + snapshot.policyDigest + commit + file.revision), workflow: structuredClone(snapshot), claimed: false, submitted: false,
      };
      this.state.records.push(record);
      await this.save();
      await this.lifecycle.reconcile(record, signal);
    }
    for (const record of this.state.records) {
      if (bindingKey(record.binding) !== bindingKey(config)) continue;
      await this.lifecycle.reconcile(record, signal);
    }
    this.syncedAt = new Date().toISOString();
    this.fault = diagnosticErrors.length ? diagnosticErrors.join(' ').slice(0, 500) : null;
  }
  private unclaimed(name: string, id: string, title: string, status: string, commit: string, issues?: string[]): SharedFeatureView {
    return { id: id || 'file-' + sharedHash(name).slice(0, 24), name, title, status, owner: null, isLocal: false, sourceCommit: commit, updatedAt: '', ready: issues ? { passed: issues.length === 0, issues } : null, done: null, featureBranch: null, reviewNote: null, publication: 'synced', error: null, taskId: null };
  }
  async note(id: string): Promise<SharedIntakeNote> {
    const record = this.state.records.find(r => r.id === id && bindingKey(r.binding) === bindingKey(this.state.config));
    if (record?.reviewMarkdown && record.reviewNote) return { path: record.reviewNote, markdown: record.reviewMarkdown };
    const item = this.discovered.find(r => r.id === id);
    if (!item?.reviewNote || !this.snapshot) throw new DomainError('not_found', 'This request has no published review note.');
    const path = item.reviewNote, root = this.snapshot.configuration.reviewDirectory + '/';
    if (!path.startsWith(root) || path.slice(root.length).includes('/') || !/^[a-zA-Z0-9_-]+\.md$/.test(path.slice(root.length))) throw new DomainError('invalid_input', 'Invalid shared review note path.');
    const markdown = await this.ports.repository(this.state.config, this.snapshot).readBlob(this.snapshot.commit, path, this.stopping.signal);
    if (markdown === null) throw new DomainError('not_found', 'The review note is not present in the last synchronized commit. Refresh shared intake.');
    return { path, markdown };
  }
  async close() { this.stopping.abort(); if (this.timer) clearTimeout(this.timer); await this.syncing; await this.configureWork.drain(); }
}
