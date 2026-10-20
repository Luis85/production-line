import { ProviderModelError, type ModelErrorCode } from './model-result.js';
/** Unknown remote completion or process cessation must outlive caller cancellation. */
export function unknownProviderOutcome(error: unknown): 'outcome_unknown' | 'process_stop_unconfirmed' | undefined {
  return error instanceof ProviderModelError && (error.code === 'outcome_unknown' || error.code === 'process_stop_unconfirmed') ? error.code : undefined;
}
export type ProviderOutcomeState = 'outcome_unknown' | 'completed' | 'failed' | 'interrupted' | 'authentication_required' | 'rate_limited' | 'quota_exhausted' | 'approval_required';
export interface ProviderFailureOutcome { state: Exclude<ProviderOutcomeState, 'completed'>; code: ModelErrorCode; message: string; automaticRetry: false; }
/** Safe common boundary for lifecycle consumers; partial work and unknown remote completion remain their concern. */
export function providerFailureOutcome(error: unknown): ProviderFailureOutcome {
  const failure = error instanceof ProviderModelError ? new ProviderModelError(error.code) : new ProviderModelError('unavailable');
  const state = unknownProviderOutcome(failure) ? 'outcome_unknown' : failure.code === 'authentication' ? 'authentication_required' : failure.code === 'rate_limit' ? 'rate_limited'
    : failure.code === 'quota' ? 'quota_exhausted' : failure.code === 'approval_required' ? 'approval_required'
      : failure.code === 'cancelled' ? 'interrupted' : 'failed';
  return { state, code: failure.code, message: failure.message, automaticRetry: false };
}
