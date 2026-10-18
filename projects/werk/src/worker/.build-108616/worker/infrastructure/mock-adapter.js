import { setTimeout as delay } from 'node:timers/promises';
                                                               

export class MockAdapter                    {
           mode = 'mock'         ;
           duration        ;

  constructor(duration        ) {
    this.duration = duration;
  }

  async run(_task      , signal             ) {
    await delay(this.duration, undefined, { signal });
    return { kind: 'simulated'         , summary: 'No code, tests or PR created' };
  }
}
