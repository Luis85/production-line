import { Agent, EnvHttpProxyAgent, fetch as transportFetch } from 'undici';
import { readResponseBody, ResponseBodyLimitError } from '../../shared/http/response-body.js';
import { ProviderModelError } from '../application/model-contract.js';

function invalidCompression(error: unknown): boolean {
  // Fetch wraps zlib/Brotli failures in TypeError. Do not mistake a dropped socket
  // for malformed content, and never expose the decoder's raw diagnostic text.
  return [error, error instanceof Error ? error.cause : undefined].some(value => {
    if (!value || typeof value !== 'object') return false;
    const { code, errno } = value as { code?: unknown; errno?: unknown };
    return typeof errno === 'number' && typeof code === 'string' && /^(?:Z_|ERR_)/.test(code);
  });
}
/** One invocation, no global dispatcher changes or implicit inference retry.
 * Request/body deadlines belong to the caller's frozen execution policy.
 */
export const providerTransport: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' || input instanceof URL ? input : input.url;
  const useEnvironmentProxy = process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy') || /(?:^|\s)--use-env-proxy(?:\s|$)/.test(process.env.NODE_OPTIONS ?? '');
  // Disable independent five-minute header/body caps. The invocation signal owns
  // the total deadline; HTTP/1.1 also avoids a protocol-fallback inference replay.
  const limits = { headersTimeout: 0, bodyTimeout: 0, allowH2: false };
  const dispatcher = useEnvironmentProxy ? new EnvHttpProxyAgent(limits) : new Agent(limits);
  try {
    const response = await transportFetch(url, {
      dispatcher, method: 'POST', redirect: 'error', headers: init?.headers as Record<string, string>,
      body: init?.body as string, signal: init?.signal ?? undefined,
    });
    let bytes: Uint8Array;
    // Undici returns the same Node WebStream at runtime; its Node declaration
    // differs from the DOM declaration in the completed reader-result shape.
    const body = response.body as unknown as ReadableStream<Uint8Array> | null;
    try { bytes = await readResponseBody(body, 1048576, { cancel: 'always' }); }
    catch (error) {
      if (init?.signal?.aborted) throw new ProviderModelError('cancelled');
      if (error instanceof ResponseBodyLimitError || response.headers.has('content-encoding') && invalidCompression(error)) throw new ProviderModelError('protocol');
      throw error;
    }
    // The bytes have been decoded and bounded before disposing this owned pool.
    const headers = new Headers([...response.headers]);
    headers.delete('content-encoding'); headers.delete('content-length');
    return new Response(response.body === null ? null : Buffer.from(bytes), { status: response.status, headers });
  } finally { await dispatcher.destroy(); }
};
