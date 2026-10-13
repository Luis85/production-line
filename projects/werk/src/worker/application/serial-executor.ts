import { DomainError } from '../../shared/errors.js';
/** One worker owns exactly one execution permit across every task source. */
export class SerialExecutor {
  private active: string | null = null;
  private readonly paused: () => boolean;
  private queue: { id: string; signal: AbortSignal; grant: (release: () => void) => void; reject: (error: unknown) => void; cancel: () => void }[] = [];
  constructor(paused: () => boolean = () => false) { this.paused = paused; }
  get current() { return this.active; }
  get busy() { return this.active !== null || this.queue.length > 0; }
  get waiting() { return this.queue.length; }
  async acquire(id: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.queue.length >= 64) throw new DomainError('conflict', 'Worker queue is full. Wait for a task to finish.');
    return new Promise((grant, reject) => {
      const entry = { id, signal, grant, reject, cancel: () => { const index = this.queue.indexOf(entry); if (index >= 0) { this.queue.splice(index, 1); reject(signal.reason); } } };
      signal.addEventListener('abort', entry.cancel, { once: true }); this.queue.push(entry); this.wake();
    });
  }
  wake() {
    if (this.active !== null || this.paused()) return;
    const entry = this.queue.shift(); if (!entry) return;
    entry.signal.removeEventListener('abort', entry.cancel);
    if (entry.signal.aborted) { entry.reject(entry.signal.reason); this.wake(); return; }
    this.active = entry.id; let released = false;
    entry.grant(() => { if (released) return; released = true; this.active = null; this.wake(); });
  }
  async run<T>(id: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const release = await this.acquire(id, signal);
    try { signal.throwIfAborted(); return await action(); } finally { release(); }
  }
}
