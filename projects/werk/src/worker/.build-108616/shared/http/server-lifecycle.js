                                                                         
import { settleCleanup } from '../lifecycle.js';
import { json, rejectRequest } from './server.js';

                                                                                                    
const owners = new WeakMap                              ();

/** Own the full asynchronous request, including work that outlives a disconnected socket. */
export class HttpRequestLifecycle {
          stopping = false;
          active = new Map                                   ();

  wrap(handler         ) {
    return (request                 , response                )                   => {
      const unavailable = () => {
        rejectRequest(request, response, 503);
        json(response, 503, { error: 'Service is stopping.' });
      };
      if (this.stopping) { unavailable(); return Promise.resolve(); }
      const controller = new AbortController();
      const disconnected = () => { if (!response.writableFinished) controller.abort(); };
      response.once('close', disconnected);
      // Reserve before calling the handler, including handlers that throw synchronously.
      const work = Promise.resolve().then(() => controller.signal.aborted ? unavailable() : handler(request, response, controller.signal));
      const settled = work.finally(() => {
        response.off('close', disconnected);
        this.active.delete(settled);
      });
      this.active.set(settled, controller);
      return settled;
    };
  }
  stop() {
    this.stopping = true;
    for (const controller of this.active.values()) controller.abort();
  }
  async drain() { await Promise.allSettled(this.active.keys()); }
}

/** Keep the existing Server return type while making its request ownership available to shutdown. */
export function trackHttpRequests(server        , requests                      )       { owners.set(server, requests); }

/** Abort owned I/O, bound socket draining, then settle handlers before their databases are disposed. */
export function drainHttpServer(server                    , timeoutMs = 5000, requests = server && owners.get(server))                {
  requests?.stop();
  if (!server) return requests?.drain() ?? Promise.resolve();
  const sockets = new Promise      ((resolve, reject) => {
    const deadline = setTimeout(() => server.closeAllConnections(), timeoutMs).unref();
    try {
      server.close(error => {
        clearTimeout(deadline);
        if (error && (error                         ).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
      server.closeIdleConnections();
    } catch (error) { clearTimeout(deadline); reject(error); }
  });
  return settleCleanup(() => sockets, () => requests?.drain());
}
