import { setTimeout as delay } from 'node:timers/promises';
import { ReportingError } from './errors.js';

/** Execution is never retried here. Shutdown permits one final best-effort report. */
export async function reportWithRetry<T>(operation: () => Promise<T>, signal: AbortSignal, shouldRetry: (error: unknown) => boolean = error => !(error instanceof ReportingError) || error.retryable): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 2 || signal.aborted || !shouldRetry(error)) throw error;
      await delay(100 * 2 ** attempt, undefined, { signal });
    }
  }
}
