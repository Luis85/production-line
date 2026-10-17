/**
 * FIFO operations with independent results: one failed write cannot poison later work.
 * The owner keeps its admission rules, persistence transaction and cancellation policy.
 * Operations may enqueue follow-up work, but must not await it inside their own run.
 */
export class SerializedOperations {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  /**
   * Wait for operations submitted before this call, even when one failed.
   * This is a snapshot, not a shutdown lock: owners must stop admissions first
   * and retain each run() result when the operation's failure must be reported.
   */
  drain(): Promise<void> { return this.tail; }
}
