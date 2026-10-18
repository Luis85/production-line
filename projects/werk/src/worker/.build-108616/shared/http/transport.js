import { Dispatcher1Wrapper } from 'undici';
import { withOwnedDispatcher } from './dispatcher.js';

/** Own the transport through body consumption. An undefined timeout leaves the deadline with init.signal. */
export async function withOwnedResponse   (url              , init             , timeoutMs                    , consume                                    , environmentProxy = true, transport               = fetch)             {
  const deadline = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  const signal = deadline ? (init.signal ? AbortSignal.any([init.signal, deadline]) : deadline) : init.signal;
  const limits = { headersTimeout: timeoutMs ?? 0, bodyTimeout: timeoutMs ?? 0, ...(timeoutMs === undefined ? {} : { connectTimeout: timeoutMs }) };
  return withOwnedDispatcher(limits, async dispatcher => {
    // Node's fetch handler contract needs the Undici 8 compatibility wrapper.
    const options = { ...init, signal, dispatcher: new Dispatcher1Wrapper(dispatcher) };
    return consume(await transport(url, options));
  }, environmentProxy);
}
