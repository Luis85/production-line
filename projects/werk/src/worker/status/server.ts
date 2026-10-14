import { WorkerAccess } from './access.js';
import { ProviderStatusChecks } from '../infrastructure/provider-status.js';
import { readFile } from 'node:fs/promises';
import { readJson, rejectRequest } from '../../shared/http/server.js';
import { ApiError, httpStatus, isExpectedError } from '../../shared/http/errors.js';
import type { WorkerWorkspace } from './workspace.js';
import { ageSeconds, monitoringThresholds, monitoringReport, operationalAlert, prometheus, type MonitoringThresholds } from '../../shared/monitoring.js';
import { createServer } from 'node:http';
import { observeHttp } from '../../shared/http/observability.js';
import { html, json } from '../../shared/io.js';
import { statusHtml } from './view.js';
export { statusHtml } from './view.js';
export interface Status {
  machineId?: string; queuedTasks?: { id: string; profile: string | null }[]; queueCapacity?: number;
  workerId: string | null; project: string | null; mode: 'mock' | 'cli'; state: string;
  taskId: string | null; attempt: number | null; profile: string | null;
  completedReviews?: number; outbox?: { pending: number; oldestAgeSeconds: number };
  completedSimulations: number; lastContact: string | null; lastError: string | null;
  updatedAt: string; profiles: {id:string;provider:string;mode:string}[];
  heartbeatErrors: number; maxParallel: number; activeTasks: {id:string;attempt:number;profile:string|null}[];
  configurationHash: string; lastSnapshot: string|null;
}
export function workerMonitoring(status: Status, thresholds: MonitoringThresholds, now = Date.now()) {
  const connected = ['idle', 'executing'].includes(status.state);
  const metrics: Record<string, number> = { werk_worker_connected: connected ? 1 : 0, werk_worker_active_tasks: status.activeTasks.length, werk_worker_heartbeat_errors: status.heartbeatErrors, werk_worker_last_contact_known: status.lastContact ? 1 : 0, werk_worker_last_contact_age_seconds: ageSeconds(now, status.lastContact ? Date.parse(status.lastContact) : null), werk_outbox_measurement_available: status.outbox ? 1 : 0 };
  if (status.outbox) { metrics.werk_outbox_pending = status.outbox.pending; metrics.werk_outbox_oldest_age_seconds = status.outbox.oldestAgeSeconds; }
  const alerts = [];
  if (!connected && status.state !== 'standalone') alerts.push(operationalAlert('worker_disconnected', 'Worker is not connected and ready for work.', 'Inspect worker lifecycle state, orchestrator availability and enrollment configuration.'));
  if (status.outbox && (status.outbox.pending >= thresholds.outboxPending || status.outbox.oldestAgeSeconds >= thresholds.outboxAgeSeconds)) alerts.push(operationalAlert('outbox_backlog', 'Durable evidence is waiting for acknowledgement.', 'Restore orchestrator connectivity and inspect delivery errors; preserve the outbox.'));
  if (!status.outbox) alerts.push(operationalAlert('outbox_unknown', 'Outbox measurement is unavailable.', 'Check worker startup and journal initialization.'));
  return monitoringReport('worker', now, metrics, alerts, thresholds);
}
export async function statusServer(get: () => Status, host: string, port: number, thresholds = monitoringThresholds(process.env), workspace?: WorkerWorkspace) {
  const access = workspace ? new WorkerAccess(token => workspace.authenticate(token), Date.now, workspace.accessScope) : undefined;
  const providers = new ProviderStatusChecks();
  const server=createServer(observeHttp('worker', async (req,res) => {
    try {
    if (workspace && req.url?.startsWith('/api/')) {
      if (await access!.route(req, res)) return;
      access!.authenticate(req);
      if (req.method === 'POST' && req.url === '/api/providers/check') { const body = await readJson(req); if (Object.keys(body).some(key => key !== 'id') || typeof body.id !== 'string') throw new ApiError(400, 'Choose a provider to check.'); return json(res, 200, await providers.check(workspace.settings.provider(body.id))); }
      if (req.method === 'GET' && req.url === '/api/features') return json(res, 200, workspace.features?.view() ?? { enabled: false });
      if (req.method === 'GET' && req.url === '/api/definitions') return json(res, 200, workspace.definitions.view());
      if (req.method === 'POST' && req.url === '/api/definitions') return json(res, 200, await workspace.definitions.action(await readJson(req)));
      if (req.method === 'POST' && req.url === '/api/tasks') return json(res, 200, await workspace.task(await readJson(req)));
      if (req.method === 'GET' && req.url === '/api/settings') return json(res, 200, workspace.settings.publicView());
      if (req.method === 'POST' && req.url === '/api/settings') return json(res, 200, await workspace.updateSettings(await readJson(req)));
      if (req.method === 'GET' && req.url === '/api/sessions') return json(res, 200, workspace.sessions.view());
      if (req.method === 'POST' && req.url === '/api/sessions') return json(res, 200, await workspace.sessions.action(await readJson(req)));
      if (req.method === 'GET' && req.url === '/api/taskboard') return json(res, 200, workspace.board.view());
      if (req.method === 'POST' && req.url === '/api/taskboard') return json(res, 202, await workspace.board.create(await readJson(req)));
      if (req.method === 'POST' && req.url === '/api/taskboard/action') return json(res, 200, await workspace.board.action(await readJson(req)));
      if (req.method === 'POST' && req.url === '/api/taskboard/detail') { const body = await readJson(req); return json(res, 200, workspace.board.detail(String(body.id))); }
      if (req.method === 'GET' && req.url === '/api/environment') return json(res, 200, await workspace.environment());
      if (req.method === 'GET' && req.url === '/api/history') return json(res, 200, await workspace.history());
      if (req.method === 'GET' && req.url === '/api/chat/session') return json(res, 200, { sessions: workspace.sessions.view(), chat: workspace.chat.snapshot() });
      if (req.method === 'GET' && req.url === '/api/chat') return json(res, 200, workspace.chat.snapshot());
      if (req.method === 'POST' && req.url === '/api/chat') { const body = await readJson(req); if (Object.keys(body).some(key => !['message', 'sessionId'].includes(key))) throw new ApiError(400, 'Expected only message'); workspace.sessions.assertSelected(body.sessionId); return json(res, 202, await workspace.startChat(body.message)); }
      if (req.method === 'POST' && ['/api/chat/cancel', '/api/chat/clear'].includes(req.url)) { const body = await readJson(req); if (Object.keys(body).some(key => key !== 'sessionId')) throw new ApiError(400, 'Expected sessionId'); workspace.sessions.assertSelected(body.sessionId); return json(res, 200, req.url.endsWith('/cancel') ? await workspace.chat.cancel() : (() => { throw new ApiError(409, 'Create a new task to start another session. Task history cannot be cleared.'); })()); }
      return json(res, 404, { error: 'Not found' });
    }
    if(req.method !== 'GET')return json(res,405,{error:'Read-only status service'});
    if (workspace && ['/', '/chat', '/history', '/dashboard', '/monitoring-status'].includes(req.url ?? '')) return html(res, await readFile(new URL('../public/index.html', import.meta.url), 'utf8'));
    if (workspace && /^\/assets\/[a-zA-Z0-9_.-]+\.(?:js|css)$/.test(req.url ?? '')) {
      try { const body = await readFile(new URL('../public' + req.url, import.meta.url)); res.writeHead(200, { 'content-type': req.url!.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' }); res.end(body); return; }
      catch { return json(res, 404, { error: 'Asset not found' }); }
    }
    if(req.url === '/')return html(res,statusHtml());
    if(req.url === '/monitoring')return json(res,200,workerMonitoring(get(),thresholds));
    if(req.url === '/metrics'){res.writeHead(200,{'content-type':'text/plain; version=0.0.4; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(prometheus(workerMonitoring(get(),thresholds)));return;}
    if(req.url === '/status')return json(res,200,get());
    if(req.url === '/healthz'){const status=get();return json(res,['idle','executing','standalone'].includes(status.state)?200:503,status);}
    return json(res,404,{error:'Not found'});
    } catch (error) { const code = httpStatus(error); rejectRequest(req, res, code); return json(res, code, { error: isExpectedError(error) ? error.message : 'Worker data could not be read or saved. Check the state directory and retry.' }); }
  }));
  server.requestTimeout=15000;server.headersTimeout=10000;
  await new Promise<void>((resolve,reject) => {server.once('error',reject);server.listen(port,host,resolve);});
  return server;
}
