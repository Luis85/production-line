import { setTimeout as delay } from 'node:timers/promises';
import type { Adapter, Task } from '../../shared/contracts.js';

export class MockAdapter implements Adapter {
  readonly mode = 'mock' as const;
  readonly duration: number;

  constructor(duration: number) {
    this.duration = duration;
  }

  async run(_task: Task, signal: AbortSignal) {
    await delay(this.duration, undefined, { signal });
    return { kind: 'simulated' as const, summary: 'No code, tests or PR created' };
  }
}
