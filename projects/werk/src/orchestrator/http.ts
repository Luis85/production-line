import { interactWithWorker } from './infrastructure/interaction.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { accessAuthorization, accessView, withAccess, requireWrite, type AccessDocument, type Principal } from '../shared/http/access.js';
import { auditMutation, type AuditSink } from '../shared/http/audit.js';
import { prometheus } from '../shared/monitoring.js';
import { DomainError } from '../shared/errors.js';
import { ApiError, httpStatus } from '../shared/http/errors.js';
import { json, html, readJson, bearerToken, rejectRequest } from '../shared/http/server.js';
import type { OrchestratorApplication, WorkerAction } from './application.js';
import type { SnapshotQuery, PageQuery } from '../shared/protocol.js';
import { identifier } from '../shared/contracts.js';

export interface HttpDependencies {
  application: OrchestratorApplication;
  schemaVersion: number;
  authorize(token: string, role: 'admin' | 'enrollment'): Principal | void;
  audit?: AuditSink;
  views: { intake: string; concept: string; guide?: string };
  reportError(error: unknown): void;
}

/** Constant-time verification lives in the transport boundary, not persistence. */
export function tokenAuthorization(adminToken: string, enrollmentToken: string, access?: AccessDocument): HttpDependencies['authorize'] {
  const authenticate = accessAuthorization(adminToken, access, [enrollmentToken]);
  return (token, role) => {
    if (role === 'admin') return authenticate(token);
    const actual = Buffer.from(token);
    const expected = Buffer.from(enrollmentToken);
    if (!expected.length || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new ApiError(401, 'Invalid enrollment token');
    }
  };
}

function queryFields(parameters: URLSearchParams, allowed: readonly string[]) {
  for (const key of parameters.keys()) {
    if (!allowed.includes(key) || parameters.getAll(key).length !== 1) {
      throw new DomainError('invalid_input', 'Unknown or repeated query parameter: ' + key);
    }
  }
}
function queryNumber(parameters: URLSearchParams, key: string) {
  if (!parameters.has(key)) return undefined;
  const value = parameters.get(key)!;
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new DomainError('invalid_input', key + ': nonnegative decimal safe integer required');
  }
  return Number(value);
}
function pageQuery(parameters: URLSearchParams): PageQuery | undefined {
  queryFields(parameters, ['limit', 'cursor']);
  if (!parameters.size) return undefined;
  return { limit: queryNumber(parameters, 'limit'), cursor: parameters.get('cursor') ?? undefined };
}
function snapshotQuery(parameters: URLSearchParams): SnapshotQuery {
  queryFields(parameters, ['project', 'worker', 'task', 'after', 'before', 'order', 'limit']);
  for (const key of ['project', 'worker', 'task']) {
    if (parameters.has(key)) identifier(parameters.get(key), key);
  }
  const number = (key: string) => queryNumber(parameters, key);
  return {
    project: parameters.get('project') ?? undefined,
    worker: parameters.get('worker') ?? undefined,
    task: parameters.get('task') ?? undefined,
    after: number('after'),
    before: number('before'),
    order: (parameters.get('order') ?? 'asc') as SnapshotQuery['order'],
    limit: number('limit'),
  };
}

/** HTTP adapts credentials, request bytes and status codes to application operations. */
export function createHttpHandler(dependencies: HttpDependencies) {
  const { application, authorize, views, reportError } = dependencies;
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const target = new URL(request.url ?? '/', 'http://localhost');
      const path = target.pathname;
      const method = request.method;
      if (method === 'GET' && path === '/healthz') {
        return json(response, 200, { ok: true, mode: dependencies.application.executionMode(), schema: dependencies.schemaVersion });
      }
      if (method === 'GET' && (path === '/' || path === '/intake')) return html(response, views.intake);
      if (method === 'GET' && path === '/concept') return html(response, views.concept);
      if (method === 'GET' && path === '/guide' && views.guide) return html(response, views.guide);

      const token = bearerToken(request);
      if (method === 'POST' && path === '/v1/workers/register') {
        authorize(token, 'enrollment');
        return json(response, 201, application.register(await readJson(request)));
      }

      if (path.startsWith('/v1/worker/')) {
        const worker = application.worker(token);
        if (method === 'GET' && path === '/v1/worker/assignments/current') {
          return json(response, 200, worker.current());
        }
        if (method === 'POST' && path === '/v1/worker/assignments/next') {
          return json(response, 200, worker.claim(await readJson(request)));
        }
        if (method === 'POST' && path === '/v1/worker/snapshots') {
          return json(response, 201, worker.snapshot(await readJson(request)));
        }
        const context = path.match(/^\/v1\/worker\/tasks\/([^/]+)\/context$/);
        if (method === 'GET' && context) {
          queryFields(target.searchParams, ['lease', 'attempt']);
          return json(response, 200, worker.context(context[1], { lease: target.searchParams.get('lease'), attempt: queryNumber(target.searchParams, 'attempt') }));
        }
        const match = path.match(/^\/v1\/worker\/tasks\/([^/]+)\/(heartbeat|complete|abandon)$/);
        if (method === 'POST' && match) {
          return json(response, 200, worker.execute(match[2] as WorkerAction, match[1], await readJson(request)));
        }
        throw new ApiError(404, 'Unknown worker endpoint');
      }

      const principal = authorize(token, 'admin') ?? { id: 'legacy-admin', role: 'admin' as const };
      auditMutation('orchestrator', request, response, principal, dependencies.audit);
      if (method !== 'GET' && method !== 'HEAD') requireWrite(principal);
      if (method === 'GET' && path === '/v1/access') { queryFields(target.searchParams, []); return json(response, 200, accessView(principal)); }
      if (method === 'GET' && (path === '/v1/monitoring' || path === '/metrics')) {
        queryFields(target.searchParams, []); const report = application.monitoring();
        if (path === '/v1/monitoring') return json(response, 200, report);
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' }); response.end(prometheus(report)); return;
      }
      if (method === 'POST' && path === '/v1/interaction') return json(response, 200, await interactWithWorker(await readJson(request), id => { application.workerDetail(id); }));
      if (path === '/v1/routing') {
        queryFields(target.searchParams, []);
        if (method === 'GET') return json(response, 200, application.routing());
        if (method === 'PUT') return json(response, 200, application.configureRouting(await readJson(request)));
      }
      const routingTask = path.match(/^\/v1\/tasks\/([^/]+)\/routing$/);
      if (method === 'PUT' && routingTask) return json(response, 200, application.routeTask(routingTask[1], await readJson(request)));
      if (method === 'POST' && path === '/v1/iteration/tasks') {
        const key = String(request.headers['idempotency-key'] ?? '');
        return json(response, 201, await application.createIterationTask(await readJson(request), key));
      }
      if (method === 'POST' && path === '/v1/tasks') {
        const key = String(request.headers['idempotency-key'] ?? '');
        return json(response, 201, await application.createTask(await readJson(request), key));
      }
      if (method === 'GET' && path === '/v1/capabilities') {
        queryFields(target.searchParams, []);
        return json(response, 200, application.capabilities());
      }
      const workerDetail = path.match(/^\/v1\/workers\/([^/]+)$/);
      if (method === 'GET' && workerDetail) {
        queryFields(target.searchParams, []);
        return json(response, 200, application.workerDetail(workerDetail[1]));
      }
      if (method === 'GET' && path === '/v1/overview') return json(response, 200, withAccess(application.overview(), principal));
      if (method === 'GET' && path === '/v1/tasks') return json(response, 200, application.tasks(pageQuery(target.searchParams)));
      if (method === 'GET' && path === '/v1/workers') return json(response, 200, application.workers(pageQuery(target.searchParams)));
      if (method === 'GET' && path === '/v1/snapshots') {
        return json(response, 200, application.snapshots(snapshotQuery(target.searchParams)));
      }
      const match = path.match(/^\/v1\/tasks\/([^/]+)(\/(?:events|context))?$/);
      if (method === 'GET' && match) {
        if (match[2] === '/context') {
          queryFields(target.searchParams, []);
          return json(response, 200, application.taskContext(match[1]));
        }
        return json(response, 200, match[2] ? application.taskEvents(match[1], pageQuery(target.searchParams)) : application.task(match[1]));
      }
      throw new ApiError(404, 'Unknown API endpoint');
    } catch (error) {
      // A disconnected upload is transport cancellation, not an application failure.
      if (request.aborted && response.destroyed && error instanceof Error && 'code' in error && error.code === 'ECONNRESET') return;
      const expected = error instanceof DomainError || error instanceof ApiError;
      const status = httpStatus(error);
      rejectRequest(request, response, status);
      json(response, status, { error: status < 500 && expected ? error.message : 'Internal server error' });
      if (status >= 500 || !expected) reportError(error);
    }
  };
}
