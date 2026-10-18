import { randomUUID } from 'node:crypto';
                                                                                                                                                                               

                               
                            
                                       
                               
                                       
                     
                                                                                                       
                      
 
/** Transition-only resource warnings; measurements never stop or retry an execution. */
export class WorkerResourceMonitor {
          dependencies                     ;
          snapshot                          = null;
          previous                  ;
          cpuHighSince                = null;
          timer                                 ;
          pending                ;
          closing                ;
          stopped = false;
          persistenceError = false;
          sampleError = false;
          sampleErrorReason                                      = null;
  constructor(dependencies                     ) { this.dependencies = dependencies; }
          now() { return (this.dependencies.now ?? Date.now)(); }
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
  status()                 {
    return { schemaVersion: 1, sampleIntervalMs: this.dependencies.intervalMs ?? 10000, policy: { ...this.dependencies.policy() }, snapshot: structuredClone(this.snapshot), alerts: this.dependencies.store.active(), persistenceError: this.persistenceError, sampleError: this.sampleError, sampleErrorReason: this.sampleErrorReason };
  }
  events(after         , limit         ) { return this.dependencies.store.events(after, limit); }
  sample()                {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.capture().finally(() => { this.pending = undefined; });
    return this.pending;
  }
          async capture() {
    let reading                 ;
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
    const active = this.dependencies.active();
    const { monotonicMs: _clock, cpuTotalMicros: _cpu, ...measurements } = reading;
    this.snapshot = { ...measurements, capturedAt: new Date(now).toISOString(), scope: 'worker_node_process', cpuCapacityBasis: 'available_parallelism', cpuCores, cpuPercent, active: active ? { sessionId: active.sessionId, startedAt: new Date(active.startedAt).toISOString(), elapsedMs: Math.max(0, reading.monotonicMs - active.monotonicStartedAt) } : null };
    this.sampleError = reading.unavailable.length > 0;
    this.sampleErrorReason = this.sampleError ? 'measurement_unavailable' : null;
    const policy = this.dependencies.policy(), snapshot = this.snapshot;
    try {
      const ratio = (used        , total               ) => total && total > 0 ? used / total * 100 : null;
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
      const long = this.dependencies.store.active().find(alert => alert.code === 'long_running');
      if (long && (!snapshot.active || long.sessionId !== snapshot.active.sessionId || long.executionStartedAt !== snapshot.active.startedAt)) this.resolve(long, 'execution_finished');
      if (snapshot.active) this.condition('long_running', snapshot.active.elapsedMs >= policy.longRunningMs, false, snapshot.active.elapsedMs, policy.longRunningMs, snapshot.active.sessionId);
      this.persistenceError = false;
    } catch { this.persistenceError = true; }
  }
          valid(reading                 ) {
    const nonnegative = (value         ) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
    const fields = ['monotonicMs', 'cpuTotalMicros', 'rssBytes', 'heapUsedBytes', 'heapLimitBytes', 'cpuCapacityCores']         ;
    const optional = ['effectiveMemoryLimitBytes', 'availableMemoryBytes', 'diskAvailableBytes', 'diskTotalBytes']         ;
    return reading && Number.isSafeInteger(reading.cpuCapacityCores) && reading.cpuCapacityCores > 0 && Number.isSafeInteger(reading.heapLimitBytes) && reading.heapLimitBytes > 0 && fields.every(key => nonnegative(reading[key])) && optional.every(key => reading[key] === null || nonnegative(reading[key])) && Number.isSafeInteger(reading.processId) && reading.processId > 0 && typeof reading.processStartId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(reading.processStartId) && Array.isArray(reading.unavailable) && reading.unavailable.every(value => ['available_memory', 'memory_capacity', 'state_filesystem'].includes(value));
  }
          unavailable(reason                                                  ) {
    if (!this.sampleError) this.dependencies.log?.('resource_sample_error');
    this.sampleError = true; this.sampleErrorReason = reason;
    this.previous = undefined; this.cpuHighSince = null;
  }
          pressure(code                   , observed               , threshold        , allowOpen = true) {
    if (observed !== null) this.condition(code, allowOpen && observed >= threshold, observed < threshold * 0.9, observed, threshold);
  }
          condition(code                   , open         , recovered         , observed        , threshold        , sessionId         ) {
    const existing = this.dependencies.store.active().find(alert => alert.code === code);
    if (existing && recovered) this.resolve({ ...existing, observed, threshold }, 'recovered');
    else if (!existing && open) {
      const alert                = { id: randomUUID(), code, severity: 'warning', openedAt: this.snapshot .capturedAt, observed, threshold, ...(sessionId ? { sessionId, executionStartedAt: this.snapshot .active .startedAt } : {}) };
      this.dependencies.store.transition(alert, 'opened', 'threshold', this.snapshot .capturedAt);
      this.dependencies.log?.('resource_alert_opened');
    }
  }
          resolve(alert               , reason                                    ) {
    this.dependencies.store.transition(alert, 'resolved', reason, this.snapshot .capturedAt);
    this.dependencies.log?.('resource_alert_resolved');
  }
  close()                {
    if (this.closing) return this.closing;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.closing = (async () => { await this.pending; try { await this.capture(); } finally { this.dependencies.store.close(); } })();
    return this.closing;
  }
}
