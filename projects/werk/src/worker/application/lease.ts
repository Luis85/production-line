import type { Task } from '../../shared/contracts.js';
import type { AttemptState, WorkerClient } from './ports.js';

/** Owns renewal timers; execution and reporting share its cancellation signal. */
export class AttemptLease {
  readonly signal: AbortSignal;
  private lost = new AbortController();
  private pulse?: NodeJS.Timeout;
  private expiry?: NodeJS.Timeout;
  private heartbeat?: Promise<void>;
  private closed = false;
  private task: Task;
  private client: Pick<WorkerClient, 'heartbeat'>;
  private state: AttemptState;
  private now: () => number;

  constructor(task: Task, client: Pick<WorkerClient, 'heartbeat'>, state: AttemptState, now = Date.now) {
    this.task = task;
    this.client = client;
    this.state = state;
    this.now = now;
    this.signal = this.lost.signal;
  }

  async start(): Promise<void> {
    this.armExpiry();
    this.signal.throwIfAborted();
    try {
      await this.renew();
    } catch (cause) {
      this.fail(cause instanceof Error ? cause : Error('Lease renewal failed'));
      throw cause;
    }
    this.signal.throwIfAborted();
    this.schedule();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.pulse);
    clearTimeout(this.expiry);
    await this.heartbeat;
  }

  private fail(error: Error): void {
    if (this.closed || this.signal.aborted) return;
    this.state.heartbeatErrors++;
    this.state.lastError = error.message;
    this.lost.abort(error);
  }

  private armExpiry(): void {
    clearTimeout(this.expiry);
    const remaining = (this.task.expiresAt ?? 0) - this.now();
    if (remaining <= 0) {
      this.fail(Error('Task lease expired'));
      return;
    }
    this.expiry = setTimeout(() => this.fail(Error('Task lease expired before renewal')), remaining);
  }

  private async renew(): Promise<void> {
    const updated = await this.client.heartbeat(this.task);
    if (this.closed) return;
    this.task.expiresAt = updated.expiresAt;
    this.state.lastContact = new Date(this.now()).toISOString();
    this.armExpiry();
  }

  private schedule(): void {
    if (this.closed || this.signal.aborted) return;
    const remaining = (this.task.expiresAt ?? 0) - this.now();
    const cadence = Math.max(20, Math.min(5000, remaining / 3));
    this.pulse = setTimeout(() => {
      this.heartbeat = this.renew()
        .catch(error => this.fail(error))
        .finally(() => {
          this.heartbeat = undefined;
          this.schedule();
        });
    }, cadence);
  }
}
