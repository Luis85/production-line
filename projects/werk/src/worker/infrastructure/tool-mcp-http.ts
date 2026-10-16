import { abortFailure, encodeMessage, MCP_WIRE_LIMIT, McpClientError, parseMessage, rpcResult, type McpClientOptions, type McpSession, type McpTransportConfiguration } from './tool-mcp-protocol.js';

/** Operator-selected HTTPS endpoints, or literal loopback HTTP; redirects are never followed. */
export function validateMcpEndpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new McpClientError('configuration'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash || url.search) throw new McpClientError('configuration');
  return url;
}

export function openMcpHttp(config: Extract<McpTransportConfiguration, { transport: 'http' }>, options: McpClientOptions, signal: AbortSignal): McpSession {
  const endpoint = validateMcpEndpoint(config.url).href, transport = options.dependencies?.fetch ?? fetch;
  let id = 0, sessionId: string | undefined, wireBytes = 0;
  const headers = () => ({ ...config.headers, accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(session.protocolVersion ? { 'MCP-Protocol-Version': session.protocolVersion } : {}), ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) });
  const account = (chunk: Uint8Array) => {
    wireBytes += chunk.length;
    if (wireBytes > MCP_WIRE_LIMIT) throw new McpClientError('output_limit');
  };
  const body = async (response: Response, requestId?: number): Promise<unknown> => {
    if (!response.body) throw new McpClientError('protocol');
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (requestId !== undefined && !['application/json', 'text/event-stream'].includes(contentType ?? '')) {
      void response.body.cancel().catch(() => {}); throw new McpClientError('protocol');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '';
    try {
      while (true) {
        if (signal.aborted) throw abortFailure(signal);
        const next = await reader.read();
        if (next.done) break;
        account(next.value);
        if (requestId === undefined && next.value.length) throw new McpClientError('protocol');
        if (contentType !== 'text/event-stream' || requestId === undefined) { chunks.push(next.value); continue; }
        pending = (pending + decoder.decode(next.value, { stream: true })).replace(/\r\n/g, '\n');
        // SSE records can contain several data lines, comments and progress notifications.
        let end: number;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const event = pending.slice(0, end); pending = pending.slice(end + 2);
          const lines = event.split('\n'), data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          const message = parseMessage(Buffer.from(data));
          if (typeof message.method === 'string' && !Object.hasOwn(message, 'id') && !Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error')) continue;
          return rpcResult(message, requestId);
        }
      }
      if (requestId === undefined) return undefined;
      if (contentType === 'text/event-stream') throw new McpClientError('protocol');
      return rpcResult(parseMessage(Buffer.concat(chunks)), requestId);
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  };
  const post = async (message: unknown, requestId?: number): Promise<unknown> => {
    if (signal.aborted) throw abortFailure(signal);
    const response = await transport(endpoint, { method: 'POST', redirect: 'error', signal, headers: headers(), body: encodeMessage(message) });
    const incomingId = response.headers.get('mcp-session-id');
    if (incomingId !== null) {
      if (!/^[\x21-\x7e]{1,1024}$/.test(incomingId) || (sessionId !== undefined && incomingId !== sessionId)) {
        void response.body?.cancel().catch(() => {}); throw new McpClientError('protocol');
      }
      sessionId = incomingId;
    }
    if (requestId !== undefined ? response.status !== 200 : ![200, 202, 204].includes(response.status)) {
      void response.body?.cancel().catch(() => {}); throw new McpClientError('unavailable');
    }
    if (requestId === undefined && !response.body) return undefined;
    return body(response, requestId);
  };
  const session: McpSession = {
    request(method, params) { const requestId = ++id; return post({ jsonrpc: '2.0', id: requestId, method, params }, requestId); },
    async notify(method, params) { await post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }); },
    async close() {
      if (!sessionId) return;
      try {
        const response = await transport(endpoint, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(1000), headers: headers() });
        await response.body?.cancel();
      } catch { /* Session deletion is best effort; the original operation remains authoritative. */ }
    },
  };
  return session;
}
