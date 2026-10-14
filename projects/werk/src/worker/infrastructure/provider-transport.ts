import { Agent, EnvHttpProxyAgent, request } from 'undici';
/** One invocation, no global dispatcher changes or implicit inference retry.
 * Request/body deadlines belong to the caller's frozen execution policy.
 */
export const providerTransport: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' || input instanceof URL ? input : input.url;
  const useEnvironmentProxy = process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy') || /(?:^|\s)--use-env-proxy(?:\s|$)/.test(process.env.NODE_OPTIONS ?? '');
  const dispatcher = useEnvironmentProxy ? new EnvHttpProxyAgent() : new Agent();
  try {
    const response = await request(url, {
      dispatcher, method: 'POST', headers: init?.headers as Record<string, string>,
      body: init?.body as string, signal: init?.signal ?? undefined,
      headersTimeout: 0, bodyTimeout: 0
    });
    // Consume under the same signal before disposing the invocation-owned pool.
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1048576) throw new Error('Provider response limit exceeded.');
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    return new Response(Buffer.concat(chunks), { status: response.statusCode, headers });
  } finally { await dispatcher.destroy(); }
};
