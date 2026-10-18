import { DomainError } from '../../shared/errors.js';
/** One worker owns exactly one execution permit across every task source. */
export class SerialExecutor {
          active                = null;
          acquiredAt                = null;
          acquiredMonotonicAt                = null;
                   paused               ;
          queue                                                                                                                                    = [];
  constructor(paused                = () => false) { this.paused = paused; }
  get current() { return this.active; }
  get startedAt() { return this.acquiredAt; }
  get startedMonotonicAt() { return this.acquiredMonotonicAt; }
  get busy() { return this.active !== null || this.queue.length > 0; }
  get waiting() { return this.queue.length; }
  async acquire(id        , signal             )                      {
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
    this.active = entry.id; this.acquiredAt = Date.now(); this.acquiredMonotonicAt = performance.now(); let released = false;
    entry.grant(() => { if (released) return; released = true; this.active = null; this.acquiredAt = null; this.acquiredMonotonicAt = null; this.wake(); });
  }
  async run   (id        , signal             , action                  )             {
    const release = await this.acquire(id, signal);
    try { signal.throwIfAborted(); return await action(); } finally { release(); }
  }
}
