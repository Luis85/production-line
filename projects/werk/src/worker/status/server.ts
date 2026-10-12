import { ageSeconds, monitoringThresholds, monitoringReport, operationalAlert, prometheus, type MonitoringThresholds } from '../../shared/monitoring.js';
import { createServer } from 'node:http';
import { observeHttp } from '../../shared/http/observability.js';
import { html, json } from '../../shared/io.js';
import { statusHtml } from './view.js';
export { statusHtml } from './view.js';
export interface Status {
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
  if (!connected) alerts.push(operationalAlert('worker_disconnected', 'Worker is not connected and ready for work.', 'Inspect worker lifecycle state, orchestrator availability and enrollment configuration.'));
  if (status.outbox && (status.outbox.pending >= thresholds.outboxPending || status.outbox.oldestAgeSeconds >= thresholds.outboxAgeSeconds)) alerts.push(operationalAlert('outbox_backlog', 'Durable evidence is waiting for acknowledgement.', 'Restore orchestrator connectivity and inspect delivery errors; preserve the outbox.'));
  if (!status.outbox) alerts.push(operationalAlert('outbox_unknown', 'Outbox measurement is unavailable.', 'Check worker startup and journal initialization.'));
  return monitoringReport('worker', now, metrics, alerts, thresholds);
}
export async function statusServer(get: () => Status, host: string, port: number, thresholds = monitoringThresholds(process.env)) {
  const server=createServer(observeHttp('worker', (req,res) => {
    if(req.method !== 'GET')return json(res,405,{error:'Read-only status service'});
    if(req.url === '/')return html(res,statusHtml());
    if(req.url === '/monitoring')return json(res,200,workerMonitoring(get(),thresholds));
    if(req.url === '/metrics'){res.writeHead(200,{'content-type':'text/plain; version=0.0.4; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(prometheus(workerMonitoring(get(),thresholds)));return;}
    if(req.url === '/status')return json(res,200,get());
    if(req.url === '/healthz'){const status=get();return json(res,['idle','executing'].includes(status.state)?200:503,status);}
    return json(res,404,{error:'Not found'});
  }));
  server.requestTimeout=15000;server.headersTimeout=10000;
  await new Promise<void>((resolve,reject) => {server.once('error',reject);server.listen(port,host,resolve);});
  return server;
}
