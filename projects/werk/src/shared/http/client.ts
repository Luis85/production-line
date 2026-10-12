import { ApiError } from './errors.js';
/** Parses bounded JSON. T describes the expected protocol; callers validate its shape. */
export async function request<T = unknown>(base: string, path: string, token: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
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
    const res = await fetch(url, { method, redirect: 'error', headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
    const reader = res.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader)
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                size += value.byteLength;
                if (size > 8 * 1024 * 1024) {
                    await reader.cancel();
                    throw new ApiError(502, 'Server response exceeds 8 MiB');
                }
                chunks.push(value);
            }
        }
        finally {
            reader.releaseLock();
        }
    let data: unknown;
    try {
        data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
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
