                                                                 
import { ApiError } from './errors.js';
const INPUT_LIMIT = 65536;
/** Reject ambiguous credentials; HTTP authentication schemes are case-insensitive. */
export function bearerToken(req                 )         {
    const count = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length;
    const match = /^Bearer[ \t]+([^\s,]+)$/i.exec(req.headers.authorization ?? '');
    if (count !== 1 || !match)
        throw new ApiError(401, 'Bearer token required');
    return match[1];
}
/** Close rejected uploads after sending the error, without buffering their remainder. */
export function rejectRequest(req                 , res                , status        ) {
    if (status === 401) res.setHeader('www-authenticate', 'Bearer');
    if (!req.complete) {
        res.setHeader('connection', 'close');
        req.resume();
    }
}
export async function readJson(req                 )                                   {
    // Node retains only the first Content-Type in headers; inspect wire metadata before parsing.
    if ((req.headersDistinct['content-type']?.length ?? 0) > 1)
        throw new ApiError(400, 'A single Content-Type header is required');
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
        throw new ApiError(415, 'Content-Type must be application/json');
    if (req.headers['content-encoding'] && req.headers['content-encoding'].toLowerCase() !== 'identity')
        throw new ApiError(415, 'Content-Encoding must be identity');
    if (Number(req.headers['content-length']) > INPUT_LIMIT)
        throw new ApiError(413, 'Body limit: 64 KiB');
    const chunks           = [];
    let size = 0;
    // Keep the socket alive long enough for the caller to send a structured 413.
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > INPUT_LIMIT)
            throw new ApiError(413, 'Body limit: 64 KiB');
        chunks.push(buffer);
    }
    let data         ;
    try {
        data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    }
    catch {
        throw new ApiError(400, 'Invalid JSON');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new ApiError(400, 'Expected JSON object');
    return data                           ;
}
export function json(res                , status        , value         ) {
    const body = JSON.stringify(value);
    if (body === undefined) throw new TypeError('Response must be JSON serializable');
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(body);
}
export function html(res                , body        ) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
    res.end(body);
}
