                                                      
                                                             

/** Owns renewal timers; execution and reporting share its cancellation signal. */
export class AttemptLease {
           signal             ;
          lost = new AbortController();
          pulse                 ;
          expiry                 ;
          heartbeat                ;
          closed = false;
          task      ;
          client                                 ;
          state              ;
          now              ;

  constructor(task      , client                                 , state              , now = Date.now) {
    this.task = task;
    this.client = client;
    this.state = state;
    this.now = now;
    this.signal = this.lost.signal;
  }

  async start()                {
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

  async close()                {
    this.closed = true;
    clearTimeout(this.pulse);
    clearTimeout(this.expiry);
    await this.heartbeat;
  }

          fail(error       )       {
    if (this.closed || this.signal.aborted) return;
    this.state.heartbeatErrors++;
    this.state.lastError = error.message;
    this.lost.abort(error);
  }

          armExpiry()       {
    clearTimeout(this.expiry);
    const remaining = (this.task.expiresAt ?? 0) - this.now();
    if (remaining <= 0) {
      this.fail(Error('Task lease expired'));
      return;
    }
    this.expiry = setTimeout(() => this.fail(Error('Task lease expired before renewal')), remaining);
  }

          async renew()                {
    const updated = await this.client.heartbeat(this.task);
    if (this.closed) return;
    this.task.expiresAt = updated.expiresAt;
    this.state.lastContact = new Date(this.now()).toISOString();
    this.armExpiry();
  }

          schedule()       {
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
