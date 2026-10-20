import { ProviderModelError, type ModelErrorCode } from './model-result.js';
export type ProviderOutcomeState = 'completed' | 'failed' | 'interrupted' | 'authentication_required' | 'rate_limited' | 'quota_exhausted' | 'approval_required';
export interface ProviderFailureOutcome { state: Exclude<ProviderOutcomeState, 'completed'>; code: ModelErrorCode; message: string; automaticRetry: false; }
/** Safe common boundary for lifecycle consumers; partial work and unknown remote completion remain their concern. */
export function providerFailureOutcome(error: unknown): ProviderFailureOutcome {
  const failure = error instanceof ProviderModelError ? new ProviderModelError(error.code) : new ProviderModelError('unavailable');
  const state = failure.code === 'authentication' ? 'authentication_required' : failure.code === 'rate_limit' ? 'rate_limited'
    : failure.code === 'quota' ? 'quota_exhausted' : failure.code === 'approval_required' ? 'approval_required'
      : failure.code === 'cancelled' ? 'interrupted' : 'failed';
  return { state, code: failure.code, message: failure.message, automaticRetry: false };
}
