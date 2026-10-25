import { inputError } from './config.mjs';

/** Explicit CLI values win over environment defaults; validate before creating runtime state. */
export function logOutputMode(value = 'file') {
  if (!['file', 'stream', 'both'].includes(value)) throw inputError('--log-output / WERK_LOG_OUTPUT must be file, stream or both.');
  return value;
}

const events = new Set(['mutation_audit', 'request_finished', 'internal_error', 'lease_reaper_error', 'attempt_error', 'state_write_error', 'connection_lost', 'connection_restored', 'service_listening']);
// Mirrors serviceRoutes and stateWriteSites in src/shared/http/observability.ts; tests keep them equal.
export const relayedRoutes = new Set(['/api/features/templates', '/api/managed-projects', '/api/processes', '/review', '/api/consumption', '/api/tool-access', '/api/tool-access/discover', '/api/execution-profiles', '/api/repositories', '/api/shared-intake', '/api/requests', '/api/resources', '/api/integrations', '/api/interactions', '/api/runs', '/api/capabilities', '/api/access', '/api/providers/check', '/api/providers/account', '/api/features', '/api/feature-tracking', '/api/definitions', '/api/tasks', '/api/chat/session', '/v1/intake', '/v1/interaction', '/v1/routing', '/dashboard', '/api/settings', '/api/sessions', '/api/taskboard', '/api/taskboard/action', '/api/taskboard/detail', '/api/worktrees', '/taskboard', '/settings', '/chat', '/history', '/monitoring-status', '/api/chat', '/api/chat/cancel', '/api/chat/clear', '/api/history', '/api/environment', '/v1/access', '/v1/monitoring', '/monitoring', '/metrics', '/', '/intake', '/concept', '/guide', '/healthz', '/status', '/v1/overview', '/v1/capabilities', '/v1/tasks', '/v1/workers', '/v1/workers/register', '/v1/snapshots', '/v1/factories', '/v1/lines', '/v1/iteration/tasks', '/v1/worker/assignments/current', '/v1/worker/assignments/next', '/v1/worker/profiles', '/v1/worker/snapshots',
  '/v1/tasks/:id', '/v1/workers/:id', '/v1/factories/:id', '/v1/lines/:id', '/v1/tasks/:id/events', '/v1/tasks/:id/context', '/v1/tasks/:id/successor', '/v1/worker/tasks/:id/context', '/v1/worker/tasks/:id/heartbeat', '/v1/worker/tasks/:id/complete', '/v1/worker/tasks/:id/abandon', '/v1/worker/tasks/:id/hold', '/v1/worker/tasks/:id/resolve-hold', '/factories/:id', '/assets/:file', 'unmatched']);
export const relayedStateWriteSites = new Set(['status_snapshot', 'board_tick', 'task_state', 'evidence_close']);
export function safeServiceLog(value) {
  if (!value || value.schemaVersion !== 1 || !['factory', 'orchestrator', 'worker'].includes(value.service) || !events.has(value.event) || !['info', 'warn', 'error'].includes(value.level) || typeof value.time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.time)) return null;
  const entry = { schemaVersion: 1, time: value.time, service: value.service, level: value.level, event: value.event };
  if (value.event === 'request_finished') {
    if (!/^[a-f0-9-]{36}$/.test(value.requestId ?? '') || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'OTHER'].includes(value.method) || !relayedRoutes.has(value.route) || !Number.isInteger(value.status) || value.status < 100 || value.status > 599 || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0) return null;
    Object.assign(entry, { requestId: value.requestId, method: value.method, route: value.route, status: value.status, durationMs: value.durationMs });
  }
  if (value.event === 'state_write_error') {
    if (relayedStateWriteSites.has(value.site)) entry.site = value.site;
    if (typeof value.code === 'string' && /^(?:E[A-Z0-9]{1,23}|SQLITE_[A-Z_]{1,40}|ERR_[A-Z0-9_]{1,60})$/.test(value.code)) entry.code = value.code;
  }
  if (value.event === 'mutation_audit') {
    const actions = /^(POST|PUT|PATCH|DELETE) (\/v1\/(tasks|iteration\/tasks|factories|lines)|\/v1\/(factories|lines)\/:id|unmatched)$/;
    if (!/^[a-f0-9-]{36}$/.test(value.requestId ?? '') || !/^[a-z][a-z0-9_-]{0,62}$/.test(value.actor ?? '') || !['admin', 'operator', 'viewer'].includes(value.role) || !actions.test(value.action ?? '') || !['succeeded', 'denied', 'failed', 'interrupted'].includes(value.outcome) || !Number.isInteger(value.status) || value.status < 100 || value.status > 599) return null;
    Object.assign(entry, { requestId: value.requestId, actor: value.actor, role: value.role, action: value.action, outcome: value.outcome, status: value.status });
  }
  return entry;
}
/** Never relay raw child stderr. Drop oversized/non-schema lines and strip unknown properties. */
export function captureServiceLogs(stream, emit) {
  let pending = '', dropping = false;
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    for (const part of chunk.split(/(?<=\n)/)) {
      if (!dropping) pending += part;
      if (Buffer.byteLength(pending, 'utf8') > 16384) { pending = ''; dropping = true; }
      if (part.endsWith('\n')) {
        if (!dropping) {
          try { const entry = safeServiceLog(JSON.parse(pending)); if (entry) emit(entry); } catch { /* Not an allowlisted service record. */ }
        }
        pending = ''; dropping = false;
      }
    }
  });
}
