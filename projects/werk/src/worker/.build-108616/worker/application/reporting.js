import { setTimeout as delay } from 'node:timers/promises';
import { ReportingError } from './errors.js';

/** Execution is never retried here. Shutdown permits one final best-effort report. */
export async function reportWithRetry   (operation                  , signal             , shouldRetry                              = error => !(error instanceof ReportingError) || error.retryable)             {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 2 || signal.aborted || !shouldRetry(error)) throw error;
      await delay(100 * 2 ** attempt, undefined, { signal });
    }
  }
}
