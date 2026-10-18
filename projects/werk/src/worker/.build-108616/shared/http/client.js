import { withOwnedResponse } from './transport.js';
import { readResponseBody, ResponseBodyLimitError } from './response-body.js';
import { ApiError } from './errors.js';
export const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
/** The client stopped waiting; the server may still finish the operation. */
export class RequestTimeoutError extends Error {
             code = 'timeout';
             timeoutMs        ;
    constructor(timeoutMs        , method        ) {
        super(`No response within ${timeoutMs / 1000} s. The ${method === 'GET' ? 'request' : 'operation'} may still be running on the server; inspect its status before retrying.`);
        this.timeoutMs = timeoutMs;
    }
}
/** Parses bounded JSON. T describes the expected protocol; callers validate its shape. */
export async function request             (base        , path        , token        , method = 'GET', body          , key         , timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS)             {
    let url     ;
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
    try {
        const options = { method, redirect: 'error'         , headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal };
        return await withOwnedResponse(url, options, timeoutMs, async res => {
            const bytes = await readResponseBody(res.body, 8 * 1024 * 1024);
            let data         ;
            try {
                data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
            }
            catch {
                throw new ApiError(res.ok ? 502 : res.status, `HTTP ${res.status}: server returned invalid JSON`);
            }
            if (!res.ok) {
                const message = data && typeof data === 'object' && !Array.isArray(data) ? (data                           ).error : undefined;
                throw new ApiError(res.status, typeof message === 'string' ? message.slice(0, 1000) : `HTTP ${res.status}`);
            }
            return data     ;
        });
    } catch (error) {
        if (error instanceof ResponseBodyLimitError) throw new ApiError(502, 'Server response exceeds 8 MiB');
        const transportCode = error instanceof Error ? (error.cause                                  )?.code : undefined;
        if ((signal.aborted && signal.reason?.name === 'TimeoutError') || (error instanceof Error && error.name === 'TimeoutError') || ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(String(transportCode))) throw new RequestTimeoutError(timeoutMs, method);
        throw error;
    }
}
