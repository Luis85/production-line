import { randomUUID } from 'node:crypto';
import type { ActiveExecution, ResourceAlert, ResourceAlertCode, ResourceEventStore, ResourcePolicy, ResourceReading, ResourceSnapshot, ResourceStatus } from './resources.js';

interface MonitorDependencies {
  store: ResourceEventStore;
  read: () => Promise<ResourceReading>;
  policy: () => ResourcePolicy;
  active: () => ActiveExecution | ActiveExecution[] | null;
  now?: () => number;
  log?: (event: 'resource_alert_opened' | 'resource_alert_resolved' | 'resource_sample_error') => void;
  intervalMs?: number;
}
/** Transition-only resource warnings; measurements never stop or retry an execution. */
export class WorkerResourceMonitor {
  private dependencies: MonitorDependencies;
  private snapshot: ResourceSnapshot | null = null;
  private previous?: ResourceReading;
  private cpuHighSince: number | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private closing?: Promise<void>;
  private stopped = false;
  private persistenceError = false;
  private sampleError = false;
  private sampleErrorReason: ResourceStatus['sampleErrorReason'] = null;
  constructor(dependencies: MonitorDependencies) { this.dependencies = dependencies; }
  private now() { return (this.dependencies.now ?? Date.now)(); }
  async init() {
    await this.dependencies.store.init();
    // Pressure belongs to a process generation. Keep its history and explicitly end old episodes.
    for (const alert of this.dependencies.store.active()) this.dependencies.store.transition(alert, 'resolved', 'worker_restarted', new Date(this.now()).toISOString());
    await this.sample();
  }
  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.sample(); }, this.dependencies.intervalMs ?? 10000);
    this.timer.unref();
  }
  status(): ResourceStatus {
    return { schemaVersion: 1, sampleIntervalMs: this.dependencies.intervalMs ?? 10000, policy: { ...this.dependencies.policy() }, snapshot: structuredClone(this.snapshot), alerts: this.dependencies.store.active(), persistenceError: this.persistenceError, sampleError: this.sampleError, sampleErrorReason: this.sampleErrorReason };
  }
  events(after?: number, limit?: number) { return this.dependencies.store.events(after, limit); }
  sample(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.capture().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async capture() {
    let reading: ResourceReading;
    try { reading = await this.dependencies.read(); }
    catch { this.unavailable('measurement_unavailable'); return; }
    if (!this.valid(reading)) { this.unavailable('invalid_measurement'); return; }
    const now = this.now(), prior = this.previous;
    const elapsed = prior && reading.processStartId === prior.processStartId ? reading.monotonicMs - prior.monotonicMs : 0;
    const cpuDelta = prior ? reading.cpuTotalMicros - prior.cpuTotalMicros : -1;
    const rawCpuCores = elapsed > 0 && cpuDelta >= 0 ? cpuDelta / (elapsed * 1000) : NaN;
    const cpuCores = Number.isFinite(rawCpuCores) && rawCpuCores >= 0 ? rawCpuCores : null;
    const cpuPercent = cpuCores === null || reading.cpuCapacityCores <= 0 ? null : cpuCores / reading.cpuCapacityCores * 100;
    if (!prior || prior.processStartId !== reading.processStartId || elapsed <= 0 || cpuDelta < 0) this.cpuHighSince = null;
    this.previous = reading;
    const observation = this.dependencies.active();
    const executions = (Array.isArray(observation) ? observation : observation ? [observation] : []).map(active => ({ sessionId: active.sessionId, projectId: active.projectId ?? null, startedAt: new Date(active.startedAt).toISOString(), elapsedMs: Math.max(0, reading.monotonicMs - active.monotonicStartedAt) }));
    const first = executions[0];
    const { monotonicMs: _clock, cpuTotalMicros: _cpu, ...measurements } = reading;
    this.snapshot = { ...measurements, capturedAt: new Date(now).toISOString(), scope: 'worker_node_process', cpuCapacityBasis: 'available_parallelism', cpuCores, cpuPercent, active: first ? { sessionId: first.sessionId, startedAt: first.startedAt, elapsedMs: first.elapsedMs } : null, ...(Array.isArray(observation) ? { activeExecutions: executions } : {}) };
    this.sampleError = reading.unavailable.length > 0;
    this.sampleErrorReason = this.sampleError ? 'measurement_unavailable' : null;
    const policy = this.dependencies.policy();
    try {
      const ratio = (used: number, total: number | null) => total && total > 0 ? used / total * 100 : null;
      this.pressure('memory', ratio(reading.rssBytes, reading.effectiveMemoryLimitBytes), policy.memoryPercent);
      this.pressure('heap', ratio(reading.heapUsedBytes, reading.heapLimitBytes), policy.heapPercent);
      if (cpuPercent !== null) {
        if (cpuPercent >= policy.cpuPercent) {
          this.cpuHighSince ??= reading.monotonicMs;
          if (reading.monotonicMs - this.cpuHighSince >= policy.cpuSustainMs) this.pressure('cpu', cpuPercent, policy.cpuPercent);
        } else {
          this.cpuHighSince = null;
          this.pressure('cpu', cpuPercent, policy.cpuPercent, false);
        }
      }
      if (reading.diskAvailableBytes !== null && reading.diskTotalBytes !== null && reading.diskTotalBytes > 0) {
        const required = Math.max(policy.diskFreeBytes, reading.diskTotalBytes * policy.diskFreePercent / 100);
        this.condition('disk', reading.diskAvailableBytes < required, reading.diskAvailableBytes > required / 0.9, reading.diskAvailableBytes, required);
      }
      for (const long of this.dependencies.store.active().filter(alert => alert.code === 'long_running'))
        if (!executions.some(active => long.sessionId === active.sessionId && long.executionStartedAt === active.startedAt)) this.resolve(long, 'execution_finished');
      for (const active of executions) this.condition('long_running', active.elapsedMs >= policy.longRunningMs, false, active.elapsedMs, policy.longRunningMs, active.sessionId, active.startedAt);
      this.persistenceError = false;
    } catch { this.persistenceError = true; }
  }
  private valid(reading: ResourceReading) {
    const nonnegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
    const fields = ['monotonicMs', 'cpuTotalMicros', 'rssBytes', 'heapUsedBytes', 'heapLimitBytes', 'cpuCapacityCores'] as const;
    const optional = ['effectiveMemoryLimitBytes', 'availableMemoryBytes', 'diskAvailableBytes', 'diskTotalBytes'] as const;
    return reading && Number.isSafeInteger(reading.cpuCapacityCores) && reading.cpuCapacityCores > 0 && Number.isSafeInteger(reading.heapLimitBytes) && reading.heapLimitBytes > 0 && fields.every(key => nonnegative(reading[key])) && optional.every(key => reading[key] === null || nonnegative(reading[key])) && Number.isSafeInteger(reading.processId) && reading.processId > 0 && typeof reading.processStartId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(reading.processStartId) && Array.isArray(reading.unavailable) && reading.unavailable.every(value => ['available_memory', 'memory_capacity', 'state_filesystem'].includes(value));
  }
  private unavailable(reason: NonNullable<ResourceStatus['sampleErrorReason']>) {
    if (!this.sampleError) this.dependencies.log?.('resource_sample_error');
    this.sampleError = true; this.sampleErrorReason = reason;
    this.previous = undefined; this.cpuHighSince = null;
  }
  private pressure(code: ResourceAlertCode, observed: number | null, threshold: number, allowOpen = true) {
    if (observed !== null) this.condition(code, allowOpen && observed >= threshold, observed < threshold * 0.9, observed, threshold);
  }
  private condition(code: ResourceAlertCode, open: boolean, recovered: boolean, observed: number, threshold: number, sessionId?: string, executionStartedAt?: string) {
    const existing = this.dependencies.store.active().find(alert => alert.code === code && alert.sessionId === sessionId);
    if (existing && recovered) this.resolve({ ...existing, observed, threshold }, 'recovered');
    else if (!existing && open) {
      const alert: ResourceAlert = { id: randomUUID(), code, severity: 'warning', openedAt: this.snapshot!.capturedAt, observed, threshold, ...(sessionId ? { sessionId, executionStartedAt: executionStartedAt! } : {}) };
      this.dependencies.store.transition(alert, 'opened', 'threshold', this.snapshot!.capturedAt);
      this.dependencies.log?.('resource_alert_opened');
    }
  }
  private resolve(alert: ResourceAlert, reason: 'recovered' | 'execution_finished') {
    this.dependencies.store.transition(alert, 'resolved', reason, this.snapshot!.capturedAt);
    this.dependencies.log?.('resource_alert_resolved');
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.closing = (async () => { await this.pending; try { await this.capture(); } finally { this.dependencies.store.close(); } })();
    return this.closing;
  }
}
