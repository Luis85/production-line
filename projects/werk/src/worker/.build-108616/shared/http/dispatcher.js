import { Agent, EnvHttpProxyAgent,                 } from 'undici';

/** One owned pool per operation; callers keep their deadlines, body limits and protocol error policy. */
export async function withOwnedDispatcher   (limits               , operation                                        , environmentProxy = true)             {
  const useProxy = environmentProxy && (process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy') || /(?:^|\s)--use-env-proxy(?:\s|$)/.test(process.env.NODE_OPTIONS ?? ''));
  // Use the packaged transport's platform fixes without changing the global dispatcher.
  const dispatcher = useProxy ? new EnvHttpProxyAgent(limits) : new Agent(limits);
  try { return await operation(dispatcher); }
  finally { await dispatcher.destroy(); }
}
