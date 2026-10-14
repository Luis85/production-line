import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse, RequestListener } from 'node:http';

export type ServiceName = 'factory' | 'orchestrator' | 'worker';
export interface ServiceEvent {
  schemaVersion: 1; time: string; service: ServiceName;
  level: 'info' | 'warn' | 'error'; event: string;
  requestId?: string; method?: string; route?: string; status?: number; durationMs?: number;
}
export type LogSink = (entry: ServiceEvent) => void;
const allowedEvents = new Set(['request_finished', 'internal_error', 'lease_reaper_error', 'intake_error', 'attempt_error', 'state_write_error', 'connection_lost', 'connection_restored', 'service_listening', 'resource_alert_opened', 'resource_alert_resolved', 'resource_sample_error']);
/** No arbitrary messages, request values, URLs, headers, paths or credentials enter this schema. */
export function serviceEvent(service: ServiceName, event: string, level: ServiceEvent['level'] = 'info', sink?: LogSink): void {
  if (!allowedEvents.has(event)) return;
  const entry: ServiceEvent = { schemaVersion: 1, time: new Date().toISOString(), service, level, event };
  try { (sink ?? writeLog)(entry); } catch { /* Diagnostic storage cannot crash application requests. */ }
}
function writeLog(entry: ServiceEvent): void { console.error(JSON.stringify(entry)); }
function routeName(raw: string | undefined): string {
  let path: string;
  try { path = new URL(raw ?? '/', 'http://localhost').pathname; } catch { return 'unmatched'; }
  const staticPaths = ['/api/requests', '/api/resources', '/api/integrations', '/api/interactions', '/api/runs', '/api/capabilities', '/api/access', '/api/providers/check', '/api/features', '/api/definitions', '/api/tasks', '/api/chat/session', '/v1/intake', '/v1/interaction', '/v1/routing', '/dashboard', '/api/settings', '/api/sessions', '/api/taskboard', '/api/taskboard/action', '/api/taskboard/detail', '/chat', '/history', '/monitoring-status', '/api/chat', '/api/chat/cancel', '/api/chat/clear', '/api/history', '/api/environment', '/v1/access', '/v1/monitoring', '/monitoring', '/metrics', '/', '/intake', '/concept', '/guide', '/healthz', '/status', '/v1/overview', '/v1/capabilities', '/v1/tasks', '/v1/workers', '/v1/workers/register', '/v1/snapshots', '/v1/factories', '/v1/lines', '/v1/iteration/tasks', '/v1/worker/assignments/current', '/v1/worker/assignments/next', '/v1/worker/snapshots'];
  if (staticPaths.includes(path)) return path;
  if (/^\/v1\/(tasks|workers|factories|lines)\/[^/]+$/.test(path)) return path.replace(/\/[^/]+$/, '/:id');
  const taskDetail = /^\/v1\/tasks\/[^/]+\/(events|context|successor)$/.exec(path);
  if (taskDetail) return '/v1/tasks/:id/' + taskDetail[1];
  const workerTask = /^\/v1\/worker\/tasks\/[^/]+\/(context|heartbeat|complete|abandon|hold|resolve-hold)$/.exec(path);
  if (workerTask) return '/v1/worker/tasks/:id/' + workerTask[1];
  if (/^\/factories\/[^/]+$/.test(path)) return '/factories/:id';
  return 'unmatched';
}
/** Correlation is generated here; supplied request IDs and request data are never logged. */
export function observeHttp(service: ServiceName, handler: (req: IncomingMessage, res: ServerResponse) => unknown, sink: LogSink = writeLog): RequestListener {
  return (request, response) => {
    const started = performance.now(), requestId = randomUUID();
    response.setHeader('x-request-id', requestId);
    const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(request.method ?? '') ? request.method! : 'OTHER';
    const route = routeName(request.url); let recorded = false;
    const record = () => {
      if (recorded) return; recorded = true;
      const status = response.writableFinished ? response.statusCode : 499;
      const entry: ServiceEvent = { schemaVersion: 1, time: new Date().toISOString(), service, level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', event: 'request_finished', requestId, method, route, status, durationMs: Math.round(Math.max(0, performance.now() - started)) };
      try { sink(entry); } catch { /* Keep serving when the diagnostic sink fails. */ }
    };
    response.once('finish', record); response.once('close', record);
    const failed = () => {
      serviceEvent(service, 'internal_error', 'error', sink);
      if (!response.headersSent) { response.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end('{"error":"Internal server error"}'); }
      else response.destroy();
    };
    try { void Promise.resolve(handler(request, response)).catch(failed); } catch { failed(); }
  };
}
