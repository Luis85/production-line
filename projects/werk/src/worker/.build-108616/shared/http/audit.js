import { randomUUID } from 'node:crypto';
                                                                 
                                             
                                                                                                                                                                                                                                                                                                              
                                                       
/** Records authenticated human/API mutations only. Never includes bodies, query, headers, IDs or errors. */
export function auditMutation(service                          , request                 , response                , principal           , sink            = entry => console.error(JSON.stringify(entry))) {
  if (!['POST', 'PATCH', 'DELETE', 'PUT'].includes(request.method ?? '')) return;
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  const staticPaths = ['/v1/tasks', '/v1/iteration/tasks', '/v1/factories', '/v1/lines'];
  const route = staticPaths.includes(path) ? path : /^\/v1\/tasks\/[^/]+\/successor$/.test(path) ? '/v1/tasks/:id/successor' : /^\/v1\/(factories|lines)\/[^/]+$/.test(path) ? path.replace(/\/[^/]+$/, '/:id') : 'unmatched';
  const header = response.getHeader('x-request-id');
  const requestId = typeof header === 'string' && /^[a-f0-9-]{36}$/.test(header) ? header : randomUUID();
  let recorded = false;
  const record = () => {
    if (recorded) return; recorded = true;
    const status = response.writableFinished ? response.statusCode : 499;
    const outcome = status === 499 ? 'interrupted' : status === 403 ? 'denied' : status >= 400 ? 'failed' : 'succeeded';
    const entry                = { schemaVersion: 1, time: new Date().toISOString(), service, level: status >= 400 ? 'warn' : 'info', event: 'mutation_audit', requestId, actor: principal.id, role: principal.role, action: `${request.method} ${route}`, outcome, status };
    try { sink(entry); } catch { /* Operational log failure must not change a committed mutation's result. */ }
  };
  response.once('finish', record); response.once('close', record);
}
