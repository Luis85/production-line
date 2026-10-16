import { Agent, Dispatcher1Wrapper, EnvHttpProxyAgent } from 'undici';
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
    const signal = AbortSignal.timeout(timeoutMs);
    // Native fetch has independent five-minute transport defaults. Keep connection,
    // headers and body waits inside this request's total deadline without changing
    // the process-wide dispatcher or retaining sockets after the response is read.
    const limits = { headersTimeout: timeoutMs, bodyTimeout: timeoutMs, connectTimeout: timeoutMs };
    const useEnvironmentProxy = process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy') || /(?:^|\s)--use-env-proxy(?:\s|$)/.test(process.env.NODE_OPTIONS ?? '');
    // Node 24 fetch uses the older handler contract; Undici 8 supplies this adapter.
    const dispatcher = new Dispatcher1Wrapper(useEnvironmentProxy ? new EnvHttpProxyAgent(limits) : new Agent(limits));
    try {
        const options = { method, redirect: 'error' as const, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal, dispatcher };
        const res = await fetch(url, options);
        const bytes = await readResponseBody(res.body, 8 * 1024 * 1024);
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
    } catch (error) {
        if (error instanceof ResponseBodyLimitError) throw new ApiError(502, 'Server response exceeds 8 MiB');
        const transportCode = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined;
        if ((signal.aborted && signal.reason?.name === 'TimeoutError') || (error instanceof Error && error.name === 'TimeoutError') || ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(String(transportCode))) throw new RequestTimeoutError(timeoutMs, method);
        throw error;
    } finally { await dispatcher.destroy(); }
}
