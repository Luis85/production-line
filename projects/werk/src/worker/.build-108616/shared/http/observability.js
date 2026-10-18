import { randomUUID } from 'node:crypto';
                                                                                  

                                                                
                                                                                                
                               
                                                       
                                                  
                                                                                            
                                                                                                       
                                       
 
                                                    
const allowedEvents = new Set(['request_finished', 'internal_error', 'lease_reaper_error', 'intake_error', 'attempt_error', 'state_write_error', 'connection_lost', 'connection_restored', 'service_listening', 'resource_alert_opened', 'resource_alert_resolved', 'resource_sample_error']);
export const stateWriteSites                            = ['status_snapshot', 'board_tick', 'task_state', 'evidence_close'];
/** Error codes are fixed identifiers such as EPERM or SQLITE_BUSY; anything else is omitted. */
export const safeErrorCode = (error         )                     => {
  const code = error && typeof error === 'object' ? (error                      ).code : undefined;
  return typeof code === 'string' && /^(?:E[A-Z0-9]{1,23}|SQLITE_[A-Z_]{1,40}|ERR_[A-Z0-9_]{1,60})$/.test(code) ? code : undefined;
};
/** No arbitrary messages, request values, URLs, headers, paths or credentials enter this schema. */
export function serviceEvent(service             , event        , level                        = 'info', sink          )       {
  if (!allowedEvents.has(event)) return;
  const entry               = { schemaVersion: 1, time: new Date().toISOString(), service, level, event };
  try { (sink ?? writeLog)(entry); } catch { /* Diagnostic storage cannot crash application requests. */ }
}
/** Reports a failed state write with its call site so operators can tell the four writers apart. */
export function stateWriteError(service             , site                , error         , sink          )       {
  const code = safeErrorCode(error);
  const entry               = { schemaVersion: 1, time: new Date().toISOString(), service, level: 'error', event: 'state_write_error', site, ...(code ? { code } : {}) };
  try { (sink ?? writeLog)(entry); } catch { /* Diagnostic storage cannot crash application requests. */ }
}
function writeLog(entry              )       { console.error(JSON.stringify(entry)); }
/** Every label routeName can emit. Runtime log filtering keeps exactly these routes. */
export const serviceRoutes                    = ['/api/consumption', '/api/tool-access', '/api/tool-access/discover', '/api/execution-profiles', '/api/repositories', '/api/shared-intake', '/api/requests', '/api/resources', '/api/integrations', '/api/interactions', '/api/runs', '/api/capabilities', '/api/access', '/api/providers/check', '/api/providers/account', '/api/features', '/api/feature-tracking', '/api/definitions', '/api/tasks', '/api/chat/session', '/v1/intake', '/v1/interaction', '/v1/routing', '/dashboard', '/api/settings', '/api/sessions', '/api/taskboard', '/api/taskboard/action', '/api/taskboard/detail', '/api/worktrees', '/taskboard', '/settings', '/chat', '/history', '/monitoring-status', '/api/chat', '/api/chat/cancel', '/api/chat/clear', '/api/history', '/api/environment', '/v1/access', '/v1/monitoring', '/monitoring', '/metrics', '/', '/intake', '/concept', '/guide', '/healthz', '/status', '/v1/overview', '/v1/capabilities', '/v1/tasks', '/v1/workers', '/v1/workers/register', '/v1/snapshots', '/v1/factories', '/v1/lines', '/v1/iteration/tasks', '/v1/worker/assignments/current', '/v1/worker/assignments/next', '/v1/worker/profiles', '/v1/worker/snapshots',
  '/v1/tasks/:id', '/v1/workers/:id', '/v1/factories/:id', '/v1/lines/:id', '/v1/tasks/:id/events', '/v1/tasks/:id/context', '/v1/tasks/:id/successor', '/v1/worker/tasks/:id/context', '/v1/worker/tasks/:id/heartbeat', '/v1/worker/tasks/:id/complete', '/v1/worker/tasks/:id/abandon', '/v1/worker/tasks/:id/hold', '/v1/worker/tasks/:id/resolve-hold', '/factories/:id', '/assets/:file', 'unmatched'];
const staticPaths = new Set(serviceRoutes.filter(route => !route.includes(':') && route !== 'unmatched'));
export function routeName(raw                    )         {
  let path        ;
  try { path = new URL(raw ?? '/', 'http://localhost').pathname; } catch { return 'unmatched'; }
  if (staticPaths.has(path)) return path;
  if (/^\/v1\/(tasks|workers|factories|lines)\/[^/]+$/.test(path)) return path.replace(/\/[^/]+$/, '/:id');
  const taskDetail = /^\/v1\/tasks\/[^/]+\/(events|context|successor)$/.exec(path);
  if (taskDetail) return '/v1/tasks/:id/' + taskDetail[1];
  const workerTask = /^\/v1\/worker\/tasks\/[^/]+\/(context|heartbeat|complete|abandon|hold|resolve-hold)$/.exec(path);
  if (workerTask) return '/v1/worker/tasks/:id/' + workerTask[1];
  if (/^\/factories\/[^/]+$/.test(path)) return '/factories/:id';
  if (/^\/assets\/[a-zA-Z0-9_.-]+\.(?:js|css)$/.test(path)) return '/assets/:file';
  return 'unmatched';
}
/** Correlation is generated here; supplied request IDs and request data are never logged. */
export function observeHttp(service             , handler                                                        , sink          = writeLog)                  {
  return (request, response) => {
    const started = performance.now(), requestId = randomUUID();
    response.setHeader('x-request-id', requestId);
    const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(request.method ?? '') ? request.method  : 'OTHER';
    const route = routeName(request.url); let recorded = false;
    const record = () => {
      if (recorded) return; recorded = true;
      const status = response.writableFinished ? response.statusCode : 499;
      const entry               = { schemaVersion: 1, time: new Date().toISOString(), service, level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', event: 'request_finished', requestId, method, route, status, durationMs: Math.round(Math.max(0, performance.now() - started)) };
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
