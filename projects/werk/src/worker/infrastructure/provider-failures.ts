import { ProviderModelError, type ModelErrorCode } from '../application/model-result.js';
const codes: Record<string, ModelErrorCode> = {
  authentication_error: 'authentication', authentication_failed: 'authentication', invalid_api_key: 'authentication', unauthorized: 'authentication',
  rate_limit: 'rate_limit', rate_limit_error: 'rate_limit', rate_limit_exceeded: 'rate_limit',
  insufficient_quota: 'quota', quota_exceeded: 'quota', billing_error: 'quota', credit_balance_too_low: 'quota',
  approval_required: 'approval_required', permission_denied: 'approval_required', permission_request: 'approval_required',
  request_cancelled: 'cancelled', interrupted: 'cancelled', invalid_request_error: 'invalid_request',
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Only structured error discriminants are trusted. Arbitrary diagnostics/model prose never becomes evidence. */
export function structuredProviderFailure(value: unknown): ProviderModelError | undefined {
  if (!record(value)) return;
  if (value.type === 'result' && Array.isArray(value.permission_denials) && value.permission_denials.length) return new ProviderModelError('approval_required');
  if (!['error', 'turn.failed', 'result'].includes(String(value.type)) || value.type === 'result' && value.is_error !== true) return;
  const error = record(value.error) ? value.error : undefined;
  for (const candidate of [error?.code, error?.type, value.error, value.code, value.subtype])
    if (typeof candidate === 'string' && Object.hasOwn(codes, candidate)) return new ProviderModelError(codes[candidate]);
  const status = error?.status ?? value.status;
  if (status === 401 || status === 403) return new ProviderModelError('authentication', status);
  if (status === 429) return new ProviderModelError('rate_limit', status);
  return new ProviderModelError('unavailable');
}
export function cliFailure(output: Buffer): ProviderModelError {
  const text = output.toString('utf8');
  try { const failure = structuredProviderFailure(JSON.parse(text)); if (failure) return failure; } catch { /* JSONL next. */ }
  for (const line of text.split('\n')) {
    try { const failure = structuredProviderFailure(JSON.parse(line)); if (failure) return failure; } catch { /* Unstructured diagnostics stay private. */ }
  }
  return new ProviderModelError('unavailable');
}
