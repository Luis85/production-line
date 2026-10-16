import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { settleCleanup } from '../lifecycle.js';
import { json, rejectRequest } from './server.js';

type Handler = (request: IncomingMessage, response: ServerResponse, signal: AbortSignal) => unknown;
const owners = new WeakMap<Server, HttpRequestLifecycle>();

/** Own the full asynchronous request, including work that outlives a disconnected socket. */
export class HttpRequestLifecycle {
  private stopping = false;
  private active = new Map<Promise<unknown>, AbortController>();

  wrap(handler: Handler) {
    return (request: IncomingMessage, response: ServerResponse): Promise<unknown> => {
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
export function trackHttpRequests(server: Server, requests: HttpRequestLifecycle): void { owners.set(server, requests); }

/** Abort owned I/O, bound socket draining, then settle handlers before their databases are disposed. */
export function drainHttpServer(server: Server | undefined, timeoutMs = 5000, requests = server && owners.get(server)): Promise<void> {
  requests?.stop();
  if (!server) return requests?.drain() ?? Promise.resolve();
  const sockets = new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => server.closeAllConnections(), timeoutMs).unref();
    try {
      server.close(error => {
        clearTimeout(deadline);
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
      server.closeIdleConnections();
    } catch (error) { clearTimeout(deadline); reject(error); }
  });
  return settleCleanup(() => sockets, () => requests?.drain());
}
