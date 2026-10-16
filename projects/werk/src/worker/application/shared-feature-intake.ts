import { DomainError } from '../../shared/errors.js';
import type { FeatureWorkflowSnapshot } from './feature-workflow.js';
import type { SharedFeatureView, SharedIntakeConfig, SharedIntakeView, SharedIntakeNote } from './shared-intake-contract.js';
import { bindingKey, defaultSharedIntakeConfig, sharedTerminal, validateSharedIntakeConfig, type SharedFeatureRecord, type SharedFeatureState, type SharedIntakePorts } from './shared-feature-state.js';
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
  private configureWork: Promise<unknown> = Promise.resolve();
  constructor(ports: SharedIntakePorts) { this.ports = ports; this.lifecycle = new SharedFeatureLifecycle(ports, () => this.save()); }
  get enabled() { return this.initialized && this.state.config.enabled; }
  get busy() { return !!this.syncing || this.configuring; }
  requiredRepositoryIds(): string[] { return [...new Set([...(this.enabled ? [this.state.config.repositoryId] : []), ...this.state.records.filter(record => !sharedTerminal(record.status) || record.publication !== 'synced').map(record => record.binding.repositoryId)])]; }
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
      state: !this.enabled ? 'disabled' : this.syncing ? 'syncing' : this.fault ? 'error' : 'idle', error: this.fault,
      lastSyncedAt: this.syncedAt, sourceCommit: workflow?.commit ?? null,
      workflow: workflow ? { ...workflow.configuration, readyDigest: workflow.files.readyCheck.sha256, doneDigest: workflow.files.doneCheck.sha256 } : null,
      requests: [...locals, ...this.discovered.filter(r => !known.has(r.id))],
    };
  }
  private publicRecord(record: SharedFeatureRecord): SharedFeatureView {
    const { id, name, title, status, owner, sourceCommit, updatedAt, ready, done, featureBranch, reviewNote, publication, error, taskId } = record;
    return structuredClone({ id, name, title, status, owner, isLocal: true, sourceCommit, updatedAt, ready, done, featureBranch, reviewNote, publication, error, taskId });
  }
  async configure(value: unknown, expectedRevision: number) {
    const config = validateSharedIntakeConfig(value);
    const operation = this.configureWork.catch(() => {}).then(async () => {
      if (this.stopping.signal.aborted) throw new DomainError('unavailable', 'Worker is stopping.');
      if (this.syncing) throw new DomainError('conflict', 'Wait for shared synchronization to finish.');
      if (expectedRevision !== this.state.revision) throw new DomainError('conflict', 'Shared intake changed. Reload before saving.');
      if (bindingKey(config) !== bindingKey(this.state.config) && this.state.records.some(record => !sharedTerminal(record.status) || record.publication !== 'synced')) throw new DomainError('conflict', 'Finish the owned requests and publish their notes before changing the shared repository binding. Disable intake to pause it.');
      if (config.enabled) this.ports.repository(config);
      const previous = this.state;
      this.configuring = true;
      this.state = { ...previous, revision: previous.revision + 1, config };
      try { await this.save(); } catch (error) { this.state = previous; throw error; } finally { this.configuring = false; }
      if (bindingKey(config) !== bindingKey(previous.config)) { this.snapshot = null; this.discovered = []; this.syncedAt = null; }
      this.fault = null;
    });
    this.configureWork = operation;
    await operation;
  }
  async sync() {
    if ((!this.enabled && !this.state.records.length) || this.stopping.signal.aborted || this.configuring) return;
    if (this.syncing) return this.syncing;
    const run = this.reconcile().catch(error => { if (!this.stopping.signal.aborted) this.fault = error instanceof Error ? error.message.slice(0, 500) : 'Shared intake could not synchronize.'; }).finally(() => { this.syncing = null; });
    this.syncing = run;
    return run;
  }
  private async reconcile() {
    const signal = this.stopping.signal, config = structuredClone(this.state.config);
    for (const record of this.state.records) {
      if (bindingKey(record.binding) !== bindingKey(config) && sharedTerminal(record.status) && record.publication === 'synced') continue;
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
    for (const { file, source } of observed) {
      signal.throwIfAborted();
      if (!source) { this.discovered.push(this.unclaimed(file.name, '', 'Invalid request', 'invalid', commit, ['The request Markdown or frontmatter is invalid.'])); continue; }
      if (source.id && ids.get(source.id)! > 1) { this.discovered.push(this.unclaimed(file.name, source.id, source.title, 'invalid', commit, ['Duplicate feature ID. Each request must have a unique stable ID.'])); continue; }
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
      if (!ready.valid || !ready.input || !ready.inputHash) { this.discovered.push(this.unclaimed(file.name, source.id ?? '', source.title, 'needs_rework', commit, ready.errors.map(e => e.message))); continue; }
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
    this.fault = null;
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
  async close() { this.stopping.abort(); if (this.timer) clearTimeout(this.timer); await this.syncing; await this.configureWork.catch(() => {}); }
}
