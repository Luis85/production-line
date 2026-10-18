import { DomainError } from '../../shared/errors.js';
import { serviceActive, serviceFingerprint, serviceLimits, serviceOperationId, validateServicePreset, validateServiceScope } from './service-policy.js';
import type { ProcessStatus, ProcessSupervisorOptions, ServiceCommand, ServiceExit, ServiceHostEvent, ServiceHostHandle, ServicePreset, ServiceRecord, ServiceStart, ServiceStopReason, StoredService } from './process-supervision.js';

interface LiveService { stored: StoredService; handle?: ServiceHostHandle; timer?: ReturnType<typeof setTimeout>; readyTimer?: ReturnType<typeof setTimeout>; readinessTail: string; }
const unavailable = (message: string) => new DomainError('unavailable', message);
const clone = <T>(value: T): T => structuredClone(value);
const bytes = (text: string) => new TextEncoder().encode(text).length;
/** Owns bounded service leases, never process IDs. Adapters own actual process containment. */
export class ProcessSupervisor {
  private readonly items = new Map<string, LiveService>();
  private pending: Promise<unknown> = Promise.resolve();
  private closing = false;
  private persistenceError = false;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private readonly options: ProcessSupervisorOptions;
  private constructor(options: ProcessSupervisorOptions) { this.options = options; }
  static async open(options: ProcessSupervisorOptions): Promise<ProcessSupervisor> {
    const owner = new ProcessSupervisor(options);
    for (const stored of await options.journal.load()) {
      validateServiceScope(stored.scope);
      if (serviceActive(stored.record.state)) Object.assign(stored.record, { state: 'interrupted', measurement: null, endedAt: owner.iso(), error: 'The previous worker ended. This service was not reattached or restarted.', revision: stored.record.revision + 1 });
      owner.items.set(stored.record.id, { stored, readinessTail: '' });
    }
    await owner.persist();
    return owner;
  }
  private now() { return (this.options.now ?? Date.now)(); }
  private iso() { return new Date(this.now()).toISOString(); }
  private maximum() { const value = typeof this.options.maxActive === 'function' ? this.options.maxActive() : this.options.maxActive; return Math.min(serviceLimits.maximumActive, Math.max(1, value ?? serviceLimits.defaultActive)); }
  private serial<T>(run: () => Promise<T>): Promise<T> { const work = this.pending.then(run, run); this.pending = work.catch(() => {}); return work; }
  private available() { if (this.closing || this.persistenceError) throw unavailable('Service supervision is stopping or its private journal is unavailable.'); }
  private preset(id: string): ServicePreset {
    const preset = this.options.presets().find(item => item.id === id && item.enabled);
    if (!preset) throw new DomainError('forbidden', 'This service preset is not currently granted.');
    return validateServicePreset(preset);
  }
  private touch(item: LiveService) { item.stored.record.revision += 1; }
  private clearTimers(item: LiveService) { if (item.timer) clearTimeout(item.timer); if (item.readyTimer) clearTimeout(item.readyTimer); item.timer = undefined; item.readyTimer = undefined; }
  private defer(run: () => Promise<unknown>, delay: number) { const timer = setTimeout(() => { void this.serial(run).catch(() => {}); }, Math.max(0, delay)); timer.unref?.(); return timer; }
  private async persist() {
    try { await this.options.journal.save([...this.items.values()].map(item => clone(item.stored))); }
    catch {
      this.persistenceError = true;
      await Promise.all([...this.items.values()].map(async item => {
        this.clearTimers(item);
        if (item.handle) {
          try { await item.handle.stop('storage_failed'); const exit = await item.handle.closed; item.handle = undefined; if (exit.reason === 'host_lost') { Object.assign(item.stored.record, { state: 'interrupted', endedAt: this.iso(), error: 'Service storage failed and descendant cleanup could not be confirmed.' }); return; } }
          catch { Object.assign(item.stored.record, { state: 'stopping', error: 'Service storage failed; descendant cleanup is still unconfirmed.' }); return; }
        }
        if (serviceActive(item.stored.record.state)) Object.assign(item.stored.record, { state: 'failed', endedAt: this.iso(), error: 'Service journal unavailable; service stopped.', lastExit: { code: null, reason: 'storage_failed' } });
      }));
      throw unavailable('The private service journal could not be saved; owned-service cleanup was requested.');
    }
  }
  private flushSoon() { if (this.closing) return; this.flushTimer ??= this.defer(async () => { this.flushTimer = undefined; await this.persist(); }, 100); }
  private prune() {
    const ended = [...this.items.values()].filter(item => !serviceActive(item.stored.record.state));
    while (this.items.size >= serviceLimits.retainedServices && ended.length) this.items.delete(ended.shift()!.stored.record.id);
  }
  async start(input: ServiceStart): Promise<ServiceRecord> {
    return this.serial(async () => {
      this.available(); validateServiceScope(input.scope);
      if (!serviceOperationId(input.operationId)) throw new DomainError('invalid_input', 'Use a bounded service operation ID.');
      const previous = [...this.items.values()].find(item => item.stored.operationId === input.operationId);
      if (previous) {
        if (previous.stored.record.presetId !== input.presetId || JSON.stringify(previous.stored.scope) !== JSON.stringify(input.scope)) throw new DomainError('conflict', 'This service operation ID already belongs to a different request.');
        return clone(previous.stored.record);
      }
      const preset = this.preset(input.presetId);
      await this.options.validateScope(clone(input.scope)); this.available();
      if (this.status().capacity.active >= this.maximum()) throw new DomainError('conflict', 'All granted service slots are occupied.');
      if ([...this.items.values()].some(item => serviceActive(item.stored.record.state) && item.stored.record.featureRequestKey === input.scope.featureRequestKey && item.stored.record.presetId === input.presetId)) throw new DomainError('conflict', 'This Feature Request already has an active service for that preset.');
      this.prune();
      const record: ServiceRecord = { id: 'service-' + crypto.randomUUID(), revision: 1, presetId: preset.id, name: preset.name, featureRequestKey: input.scope.featureRequestKey, sessionId: input.scope.sessionId, ...(input.scope.taskId ? { taskId: input.scope.taskId } : {}), ...(input.scope.runId ? { runId: input.scope.runId } : {}), state: 'starting', generation: 0, restartCount: 0, restartLimit: preset.restart.maxAttempts, createdAt: this.iso(), startedAt: null, endedAt: null, expiresAt: new Date(this.now() + preset.ttlMs).toISOString(), readiness: preset.readyText ? 'waiting' : 'not_configured', readyAt: null, lastExit: null, error: null, measurement: null };
      const item: LiveService = { stored: { record, scope: clone(input.scope), presetFingerprint: serviceFingerprint(preset), operationId: input.operationId, logs: [], nextLogSequence: 1, commands: [] }, readinessTail: '' };
      this.items.set(record.id, item); await this.persist(); await this.launch(item);
      return clone(record);
    });
  }
  private async launch(item: LiveService) {
    const record = item.stored.record;
    try {
      this.available();
      const preset = this.preset(record.presetId);
      if (serviceFingerprint(preset) !== item.stored.presetFingerprint) throw new DomainError('forbidden', 'The service preset changed; start a new explicitly granted service.');
      await this.options.validateScope(clone(item.stored.scope)); this.available();
      // Validation may await I/O: recheck the current grant immediately before launch.
      if (serviceFingerprint(this.preset(record.presetId)) !== item.stored.presetFingerprint) throw new DomainError('forbidden', 'The service grant changed during validation.');
      if (Date.parse(record.expiresAt) <= this.now()) { await this.stopItem(item, 'ttl'); return; }
      this.clearTimers(item); record.generation += 1; record.state = 'starting'; record.measurement = null; record.readyAt = null; record.readiness = preset.readyText ? 'waiting' : 'not_configured'; item.readinessTail = ''; this.touch(item);
      await this.persist();
      await this.options.validateScope(clone(item.stored.scope)); this.available();
      if (serviceFingerprint(this.preset(record.presetId)) !== item.stored.presetFingerprint) throw new DomainError('forbidden', 'The service grant changed before process launch.');
      if (Date.parse(record.expiresAt) <= this.now()) { await this.stopItem(item, 'ttl'); return; }
      const generation = record.generation;
      item.handle = await this.options.host.start({ preset, scope: clone(item.stored.scope), expiresAt: record.expiresAt, onEvent: event => { if (record.generation === generation) this.event(item, event, preset); } });
      record.state = 'running'; record.startedAt = this.iso(); record.endedAt = null; record.error = null; this.touch(item);
      const handle = item.handle;
      void handle.closed.then(exit => this.serial(async () => { if (item.handle === handle) { item.handle = undefined; await this.finished(item, exit); } })).catch(() => {});
      item.timer = this.defer(() => this.stopItem(item, 'ttl'), Date.parse(record.expiresAt) - this.now());
      if (preset.readyText && record.readiness === 'waiting') item.readyTimer = this.defer(async () => { record.readiness = 'timed_out'; await this.stopItem(item, 'startup_timeout'); }, preset.startupTimeoutMs);
      await this.persist();
    } catch (error) {
      this.clearTimers(item);
      if (item.handle) {
        try { await item.handle.stop('storage_failed'); const exit = await item.handle.closed; item.handle = undefined; if (exit.reason === 'host_lost') { record.state = 'interrupted'; record.error = 'The service host disappeared; descendant cleanup could not be confirmed.'; await this.persist(); return; } }
        catch { record.state = 'stopping'; record.error = 'Service startup failed; descendant cleanup is still unconfirmed.'; throw unavailable(record.error); }
      }
      record.state = 'failed'; record.endedAt = this.iso(); record.error = error instanceof DomainError ? error.message : 'The approved service could not start.'; this.touch(item);
      await this.persist();
    }
  }
  private event(item: LiveService, event: ServiceHostEvent, preset: ServicePreset) {
    const record = item.stored.record;
    if (!serviceActive(record.state) || this.persistenceError) return;
    if (event.type === 'measurement') record.measurement = clone(event.value);
    else {
      let text = event.text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
      while (bytes(text) > serviceLimits.maxLogBytes) text = text.slice(Math.ceil(text.length / 4));
      if (text) item.stored.logs.push({ sequence: item.stored.nextLogSequence++, at: this.iso(), stream: event.stream, text });
      while (item.stored.logs.length > serviceLimits.maxLogEntries || item.stored.logs.reduce((sum, row) => sum + bytes(row.text), 0) > serviceLimits.maxLogBytes) item.stored.logs.shift();
      if (preset.readyText && record.readiness === 'waiting') {
        item.readinessTail = (item.readinessTail + text).slice(-serviceLimits.maxLogBytes);
        if (item.readinessTail.includes(preset.readyText)) { record.readiness = 'reported'; record.readyAt = this.iso(); this.touch(item); if (item.readyTimer) clearTimeout(item.readyTimer); }
      }
    }
    this.flushSoon();
  }
  private async finished(item: LiveService, exit: ServiceExit) {
    this.clearTimers(item);
    const record = item.stored.record;
    record.lastExit = exit; record.endedAt = this.iso(); record.measurement = null; this.touch(item);
    const restartable = ['exit', 'spawn_failed'].includes(exit.reason) && exit.code !== 0;
    let preset: ServicePreset | undefined;
    try { preset = this.preset(record.presetId); } catch { /* Revoked grants cannot restart. */ }
    if (!this.closing && !this.persistenceError && restartable && preset && serviceFingerprint(preset) === item.stored.presetFingerprint && record.restartCount < preset.restart.maxAttempts && this.now() + preset.restart.backoffMs < Date.parse(record.expiresAt)) {
      record.restartCount += 1; record.state = 'restarting'; record.error = 'The service exited; a bounded restart is scheduled.';
      item.timer = this.defer(() => this.launch(item), preset.restart.backoffMs);
    } else if (exit.reason === 'host_lost') { record.state = 'interrupted'; record.error = 'The service host disappeared; descendant cleanup could not be confirmed. No restart was attempted.'; }
    else { record.state = exit.reason === 'exit' && exit.code !== 0 || ['spawn_failed', 'host_lost'].includes(exit.reason) ? 'failed' : 'stopped'; record.error = record.state === 'failed' ? 'The service ended unexpectedly; inspect its private logs.' : null; }
    await this.persist();
  }
  private async stopItem(item: LiveService, reason: ServiceStopReason) {
    this.clearTimers(item);
    if (!serviceActive(item.stored.record.state) && !item.handle) return;
    const record = item.stored.record; record.state = 'stopping'; this.touch(item); await this.persist();
    const handle = item.handle;
    if (handle) { await handle.stop(reason); const exit = await handle.closed; if (item.handle === handle) item.handle = undefined; if (exit.reason === 'host_lost') { await this.finished(item, exit); return; } }
    record.state = 'stopped'; record.endedAt = this.iso(); record.lastExit = { code: null, reason }; record.measurement = null; record.error = null; this.touch(item); await this.persist();
  }
  private command(input: ServiceCommand, action: 'stop' | 'restart'): { item: LiveService; replay: boolean } {
    if (!serviceOperationId(input.operationId) || !Number.isSafeInteger(input.expectedRevision)) throw new DomainError('invalid_input', 'Use a service operation ID and its current revision.');
    const item = this.items.get(input.id); if (!item) throw new DomainError('not_found', 'This service is not retained by the worker.');
    const receipts = item.stored.commands ??= [];
    const previous = receipts.find(receipt => receipt.operationId === input.operationId);
    if (previous) { if (previous.action !== action || previous.expectedRevision !== input.expectedRevision) throw new DomainError('conflict', 'This operation ID already belongs to a different command.'); return { item, replay: true }; }
    if (item.stored.record.revision !== input.expectedRevision) throw new DomainError('conflict', 'The service changed; refresh before trying again.');
    return { item, replay: false };
  }
  private receipt(item: LiveService, input: ServiceCommand, action: 'stop' | 'restart') { const receipts = item.stored.commands ??= []; receipts.push({ operationId: input.operationId, action, expectedRevision: input.expectedRevision }); if (receipts.length > 32) receipts.shift(); }
  async stop(input: ServiceCommand, reason: ServiceStopReason = 'operator') { return this.serial(async () => { const { item, replay } = this.command(input, 'stop'); if (!replay) { this.receipt(item, input, 'stop'); await this.persist(); await this.stopItem(item, reason); } return clone(item.stored.record); }); }
  async controls(id: string): Promise<{ stop: boolean; restart: boolean; restartUnavailableReason: string | null }> {
    return this.serial(async () => {
      const item = this.items.get(id); if (!item) throw new DomainError('not_found', 'This service is not retained by the worker.');
      const stop = serviceActive(item.stored.record.state);
      try {
        this.available(); const preset = this.preset(item.stored.record.presetId);
        if (item.stored.record.state === 'interrupted') throw new DomainError('conflict', 'Interrupted services require a new explicit start after inspecting their previous state.');
        if (serviceFingerprint(preset) !== item.stored.presetFingerprint) throw new Error('The preset changed; start a new service.');
        if (Date.parse(item.stored.record.expiresAt) <= this.now()) throw new Error('The service lifetime has expired.');
        if (item.stored.record.restartCount >= preset.restart.maxAttempts) throw new Error('The granted restart budget is exhausted.');
        if (!stop && this.status().capacity.active >= this.maximum()) throw new Error('All granted service slots are occupied.');
        await this.options.validateScope(clone(item.stored.scope));
        return { stop, restart: true, restartUnavailableReason: null };
      } catch (error) { return { stop, restart: false, restartUnavailableReason: error instanceof DomainError ? error.message : error instanceof Error && ['The preset changed; start a new service.', 'The service lifetime has expired.', 'The granted restart budget is exhausted.', 'All granted service slots are occupied.'].includes(error.message) ? error.message : 'The Feature Request or its pinned worktree is no longer available.' }; }
    });
  }
  async restart(input: ServiceCommand) {
    return this.serial(async () => {
      this.available(); const { item, replay } = this.command(input, 'restart'); if (replay) return clone(item.stored.record);
      const preset = this.preset(item.stored.record.presetId);
      if (item.stored.record.state === 'interrupted') throw new DomainError('conflict', 'Interrupted services require a new explicit start after inspecting their previous state.');
      if (Date.parse(item.stored.record.expiresAt) <= this.now()) throw new DomainError('conflict', 'The service lifetime has expired; start a new explicitly granted service.');
      if (item.stored.record.restartCount >= preset.restart.maxAttempts) throw new DomainError('conflict', 'This service has used its granted restart budget.');
      if (!serviceActive(item.stored.record.state) && this.status().capacity.active >= this.maximum()) throw new DomainError('conflict', 'All granted service slots are occupied.');
      this.receipt(item, input, 'restart'); await this.persist(); await this.stopItem(item, 'operator');
      if (!['stopped', 'failed'].includes(item.stored.record.state) || item.handle) throw unavailable('Previous service cleanup could not be confirmed; no replacement was launched.');
      item.stored.record.restartCount += 1; await this.launch(item); return clone(item.stored.record);
    });
  }
  private async drain(reason: ServiceStopReason, featureRequestKey?: string) {
    let failure: unknown;
    for (const item of this.items.values()) if (!featureRequestKey || item.stored.record.featureRequestKey === featureRequestKey) { try { await this.stopItem(item, reason); } catch (error) { failure ??= error; } }
    if (failure) throw failure;
  }
  async stopFeature(featureRequestKey: string, reason: ServiceStopReason = 'feature_ended') { return this.serial(() => this.drain(reason, featureRequestKey)); }
  async reconcileGrants() { return this.serial(async () => { for (const item of this.items.values()) if (serviceActive(item.stored.record.state)) { try { if (serviceFingerprint(this.preset(item.stored.record.presetId)) !== item.stored.presetFingerprint) throw new Error(); await this.options.validateScope(clone(item.stored.scope)); } catch { await this.stopItem(item, 'revoked'); } } }); }
  async close() {
    this.closing = true;
    return this.serial(async () => { if (this.flushTimer) clearTimeout(this.flushTimer); this.flushTimer = undefined; await this.drain('shutdown'); await this.persist(); });
  }
  logs(id: string, options: { after?: number; limit?: number } = {}) {
    const item = this.items.get(id); if (!item) throw new DomainError('not_found', 'This service is not retained by the worker.');
    const after = Math.max(0, options.after ?? 0), limit = Math.min(128, Math.max(1, options.limit ?? 64));
    const entries = clone(item.stored.logs.filter(row => row.sequence > after).slice(0, limit));
    return { entries, nextAfter: entries.at(-1)?.sequence ?? after, gap: (item.stored.logs[0]?.sequence ?? 1) > after + 1 };
  }
  status(): ProcessStatus {
    const services = [...this.items.values()].map(item => clone(item.stored.record));
    const active = services.filter(row => serviceActive(row.state));
    const measured = active.filter(row => row.measurement?.coverage === 'complete_group' && this.now() - Date.parse(row.measurement.capturedAt) <= 15000 && row.measurement.rssBytes !== null && row.measurement.cpuTotalMicros !== null);
    const coverage = measured.length === 0 ? 'unavailable' : measured.length === active.length ? 'complete' : 'partial';
    return { schemaVersion: 1, scope: 'worker_owned_services', capturedAt: this.iso(), sampleIntervalMs: 5000, services, capacity: { active: active.length, maximum: this.maximum() }, summary: { running: services.filter(row => row.state === 'running').length, starting: services.filter(row => ['starting', 'restarting'].includes(row.state)).length, failed: services.filter(row => ['failed', 'interrupted'].includes(row.state)).length, restarts: services.reduce((sum, row) => sum + row.restartCount, 0), rssBytes: measured.length ? measured.reduce((sum, row) => sum + row.measurement!.rssBytes!, 0) : null, cpuTotalMicros: measured.length ? measured.reduce((sum, row) => sum + row.measurement!.cpuTotalMicros!, 0) : null, measuredGroups: measured.length, activeGroups: active.length, coverage }, persistenceError: this.persistenceError };
  }
}
