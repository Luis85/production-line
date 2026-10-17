import { Agent, Dispatcher1Wrapper, EnvHttpProxyAgent } from 'undici';

/** Own the transport until the complete response has been consumed, including failure cleanup. */
export async function withOwnedResponse<T>(url: string | URL, init: RequestInit, timeoutMs: number, consume: (response: Response) => Promise<T>, environmentProxy = true): Promise<T> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  const limits = { headersTimeout: timeoutMs, bodyTimeout: timeoutMs, connectTimeout: timeoutMs };
  const useProxy = environmentProxy && (process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy') || /(?:^|\s)--use-env-proxy(?:\s|$)/.test(process.env.NODE_OPTIONS ?? ''));
  // The packaged dispatcher includes platform socket fixes absent from some Node 24 builds.
  // Node's fetch handler contract needs the Undici 8 compatibility wrapper.
  const dispatcher = new Dispatcher1Wrapper(useProxy ? new EnvHttpProxyAgent(limits) : new Agent(limits));
  try {
    const options = { ...init, signal, dispatcher };
    return await consume(await fetch(url, options));
  } finally { await dispatcher.destroy(); }
}
