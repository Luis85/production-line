/** JSON transport only. Authentication, response adoption and retries belong to each application. */
export class WebviewHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.name = 'WebviewHttpError'; this.status = status; }
}
export function boundedSignal(signal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}
export interface JsonRequestInput {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
  signal?: AbortSignal | null;
  timeoutMs: number;
}
/** Shared wire defaults; callers still own authentication, request identity and deadlines. */
export function jsonRequestInit(options: JsonRequestInput): RequestInit {
  return {
    method: options.method ?? 'GET',
    cache: 'no-store',
    signal: boundedSignal(options.signal, options.timeoutMs),
    headers: { ...options.headers, ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  };
}
export interface JsonRequestOptions {
  fetcher?: typeof fetch;
  onResponse?: (response: Response) => void;
  invalidJson?: (status: number) => string;
  failure?: (status: number) => string;
}
export async function requestJson<T = unknown>(path: string, init: RequestInit = {}, options: JsonRequestOptions = {}): Promise<T> {
  const response = await (options.fetcher ?? fetch)(path, init);
  // A 401 must reach the owning application's epoch policy even for HTML proxy errors.
  options.onResponse?.(response);
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new WebviewHttpError(options.invalidJson?.(response.status) ?? `Unreadable JSON response (HTTP ${response.status}).`, response.status); }
  if (!response.ok) {
    const message = value && typeof value === 'object' && 'error' in value && typeof value.error === 'string' ? value.error : null;
    throw new WebviewHttpError(message || options.failure?.(response.status) || `Request failed (${response.status})`, response.status);
  }
  return value as T;
}
