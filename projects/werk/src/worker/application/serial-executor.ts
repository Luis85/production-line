import { DomainError } from '../../shared/errors.js';
import { MAX_WORKER_PARALLEL } from './delivery-coordination.js';
export interface ExecutionPermitOptions { /** Trusted remote simulations only; never supplied by model or user input. */ startupIndependent?: boolean; continuation?: boolean; projectId?: string; projectLimit?: number; }
export interface ReservedExecutionPermit { sessionId: string; projectId: string | null; projectLimit: number; }
export interface ActiveExecutionPermit { sessionId: string; projectId: string | null; projectLimit: number; startedAt: number; monotonicStartedAt: number; }
interface WaitingPermit extends ExecutionPermitOptions { id: string; signal: AbortSignal; grant: (release: () => void) => void; reject: (error: unknown) => void; cancel: () => void; }
/** One authority owns all execution permits. Unscoped legacy operations remain exclusive. */
export class SerialExecutor {
  private readonly active = new Map<string, ActiveExecutionPermit>();
  private readonly retained = new Set<string>();
  private readonly paused: () => boolean;
  private readonly configuredLimit: () => number;
  private queue: WaitingPermit[] = [];
  private nativeStartupHolds = 0;
  /** Native initialization holds real work, including continuations, without changing saved pause policy. */
  suspendNativeWork(): () => void {
    this.nativeStartupHolds++; let released = false;
    return () => { if (released) return; released = true; this.nativeStartupHolds--; this.wake(); };
  }
  private readonly unresolved: () => ReservedExecutionPermit[];
  constructor(paused: () => boolean = () => false, limit: () => number = () => 1, unresolved: () => ReservedExecutionPermit[] = () => []) { this.paused = paused; this.configuredLimit = limit; this.unresolved = unresolved; }
  get limit() { const value = this.configuredLimit(); return Number.isSafeInteger(value) ? Math.max(1, Math.min(MAX_WORKER_PARALLEL, value)) : 1; }
  get executions(): ActiveExecutionPermit[] { return [...this.active.values()].map(item => ({ ...item })); }
  get reservedExecutions(): ReservedExecutionPermit[] { return [...new Map(this.unresolved().filter(item => !this.active.has(item.sessionId)).map(item => [item.sessionId, { ...item }])).values()]; }
  private get occupancy() { return [...this.active.values(), ...this.reservedExecutions]; }
  get current() { return this.active.keys().next().value ?? null; }
  get startedAt() { return this.active.values().next().value?.startedAt ?? null; }
  get startedMonotonicAt() { return this.active.values().next().value?.monotonicStartedAt ?? null; }
  get busy() { return this.occupancy.length > 0 || this.queue.length > 0; }
  get waiting() { return this.queue.length; }
  has(id: string) { return this.active.has(id); }
  /** A failed durable uncertainty write keeps its live permit until restart recovery can inspect the run. */
  retainUncertain(id: string): void { if (this.active.has(id)) this.retained.add(id); }
  assertResolved(id: string, options: ExecutionPermitOptions = {}): void {
    if (this.reservedExecutions.some(item => item.sessionId === id || item.projectId === null || !options.projectId)) throw new DomainError('conflict', 'Reconcile the unresolved execution before starting or resuming model work.');
  }
  async acquire(id: string, signal: AbortSignal, options: ExecutionPermitOptions = {}): Promise<() => void> {
    signal.throwIfAborted();
    if (options.projectId !== undefined && (!options.projectId.trim() || options.projectId.length > 4096) || options.projectLimit !== undefined && (!Number.isSafeInteger(options.projectLimit) || options.projectLimit < 1 || options.projectLimit > MAX_WORKER_PARALLEL)) throw new DomainError('invalid_input', 'Execution permits require a project identity and a limit from 1 to 8.');
    this.assertResolved(id, options);
    if (this.queue.length >= 64) throw new DomainError('conflict', 'Worker queue is full. Wait for a task to finish.');
    return new Promise((grant, reject) => {
      const entry: WaitingPermit = { ...options, id, signal, continuation: options.continuation === true, grant, reject, cancel: () => { const index = this.queue.indexOf(entry); if (index >= 0) { this.queue.splice(index, 1); reject(signal.reason); this.wake(); } } };
      signal.addEventListener('abort', entry.cancel, { once: true }); this.queue.push(entry); this.wake();
    });
  }
  canStart(id: string, options: ExecutionPermitOptions = {}): boolean {
    return (this.nativeStartupHolds === 0 || options.startupIndependent === true) && (!this.paused() || options.continuation === true) && this.occupancy.length < this.limit &&
      !this.queue.some(entry => !entry.projectId && (!this.nativeStartupHolds || entry.startupIndependent === true) && (!this.paused() || entry.continuation)) && this.permitted({ id, ...options });
  }
  private permitted(entry: Pick<WaitingPermit, 'id' | 'projectId' | 'projectLimit'>): boolean {
    const occupied = this.occupancy;
    if (occupied.some(item => item.sessionId === entry.id)) return false;
    if (!entry.projectId || occupied.some(item => item.projectId === null)) return occupied.length === 0;
    const project = occupied.filter(item => item.projectId === entry.projectId);
    const limit = Math.min(entry.projectLimit ?? 1, ...project.map(item => item.projectLimit));
    return project.length < limit;
  }
  wake() {
    while (this.occupancy.length < this.limit) {
      let index = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const entry = this.queue[i];
        if (this.nativeStartupHolds && entry.startupIndependent !== true || this.paused() && !entry.continuation) continue;
        if (this.permitted(entry)) { index = i; break; }
        // Drain existing work before the next unscoped operation; later work cannot starve it.
        if (!entry.projectId) break;
      }
      if (index < 0) return;
      const entry = this.queue.splice(index, 1)[0];
      entry.signal.removeEventListener('abort', entry.cancel);
      if (entry.signal.aborted) { entry.reject(entry.signal.reason); continue; }
      this.active.set(entry.id, { sessionId: entry.id, projectId: entry.projectId ?? null, projectLimit: entry.projectLimit ?? 1, startedAt: Date.now(), monotonicStartedAt: performance.now() });
      let released = false;
      entry.grant(() => { if (released || this.retained.has(entry.id)) return; released = true; this.active.delete(entry.id); this.wake(); });
    }
  }
  async run<T>(id: string, signal: AbortSignal, action: () => Promise<T>, options: ExecutionPermitOptions = {}): Promise<T> {
    const release = await this.acquire(id, signal, options);
    try { signal.throwIfAborted(); return await action(); } finally { release(); }
  }
}
