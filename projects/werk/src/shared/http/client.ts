import { readResponseBody, ResponseBodyLimitError } from './response-body.js';
import { ApiError } from './errors.js';
export const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
/** The client stopped waiting; the server may still finish the operation. */
export class RequestTimeoutError extends Error {
    readonly code = 'timeout';
    readonly timeoutMs: number;
    constructor(timeoutMs: number, method: string) {
        super(`No response within ${timeoutMs / 1000} s. The ${method === 'GET' ? 'request' : 'operation'} may still be running on the server; inspect its status before retrying.`);
        this.timeoutMs = timeoutMs;
    }
}
/** Parses bounded JSON. T describes the expected protocol; callers validate its shape. */
export async function request<T = unknown>(base: string, path: string, token: string, method = 'GET', body?: unknown, key?: string, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    let url: URL;
    try {
        const origin = new URL(base);
        if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || !path.startsWith('/') || path.startsWith('//'))
            throw Error('Invalid endpoint');
        url = new URL(path, origin);
        if (url.origin !== origin.origin)
            throw Error('Invalid endpoint');
    }
    catch {
        throw new ApiError(400, 'URL must be HTTP(S) without credentials; API path must be local');
    }
    const timedOut = (error: unknown) => error instanceof Error && error.name === 'TimeoutError' ? new RequestTimeoutError(timeoutMs, method) : error;
    let res: Response;
    try { res = await fetch(url, { method, redirect: 'error', headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) }); }
    catch (error) { throw timedOut(error); }
    let bytes: Uint8Array;
    try { bytes = await readResponseBody(res.body, 8 * 1024 * 1024); }
    catch (error) {
        if (error instanceof ResponseBodyLimitError) throw new ApiError(502, 'Server response exceeds 8 MiB');
        throw timedOut(error);
    }
    let data: unknown;
    try {
        data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    catch {
        throw new ApiError(res.ok ? 502 : res.status, `HTTP ${res.status}: server returned invalid JSON`);
    }
    if (!res.ok) {
        const message = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>).error : undefined;
        throw new ApiError(res.status, typeof message === 'string' ? message.slice(0, 1000) : `HTTP ${res.status}`);
    }
    return data as T;
}
