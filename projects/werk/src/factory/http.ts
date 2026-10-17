import type { WorkerInteractionResponse } from '../shared/worker-interaction.js';
import { taskPageQuery } from './application/task-pages.js';
import type { FactoryIntake } from './application/intake.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { accessAuthorization, accessView, withAccess, requireWrite, type AccessDocument } from '../shared/http/access.js';
import { auditMutation, type AuditSink } from '../shared/http/audit.js';
import { prometheus } from '../shared/monitoring.js';
import { DomainError } from '../shared/errors.js';
import { httpStatus, isExpectedError } from '../shared/http/errors.js';
import { json, html, readJson, bearerToken, rejectRequest } from '../shared/http/server.js';
import { identifier } from '../shared/contracts.js';
import type { FactoryApplication } from './application/service.js';
import { mutationKey } from './application/mutations.js';
import { FACTORY_SCHEMA_VERSION } from './infrastructure/schema.js';

function requestKey(request: IncomingMessage): string | undefined {
    const values = request.headersDistinct['idempotency-key'];
    if (values && values.length !== 1) throw new DomainError('invalid_input', 'A single Idempotency-Key header is required');
    return mutationKey(values?.[0]);
}
export function createFactoryHandler(application: FactoryApplication, adminToken: string, view: string, reportError: (error: unknown) => void, guide?: string, access?: AccessDocument, audit?: AuditSink, intake?: FactoryIntake, interaction?: (id: string, input: unknown, signal?: AbortSignal) => Promise<WorkerInteractionResponse>) {
    const authenticate = accessAuthorization(adminToken, access);
    return async (request: IncomingMessage, response: ServerResponse, signal?: AbortSignal) => {
        try {
            const target = new URL(request.url ?? '/', 'http://localhost'), path = target.pathname, method = request.method;
            if (method === 'GET' && path === '/healthz')
                return json(response, 200, { ok: true, service: 'factory', schema: FACTORY_SCHEMA_VERSION });
            if (method === 'GET' && path === '/guide' && guide) return html(response, guide);
            if (method === 'GET' && (path === '/' || /^\/factories\/[^/]+$/.test(path)))
                return html(response, view);
            const principal = authenticate(bearerToken(request));
            auditMutation('factory', request, response, principal, audit);
            if (method !== 'GET' && method !== 'HEAD') requireWrite(principal);
            if (method === 'GET' && path === '/v1/access') { if (target.searchParams.size) throw new DomainError('invalid_input', 'No query parameters allowed'); return json(response, 200, accessView(principal)); }
            if (method === 'GET' && (path === '/v1/monitoring' || path === '/metrics')) {
                if (target.searchParams.size) throw new DomainError('invalid_input', 'No query parameters allowed');
                const report = await application.monitoring();
                if (path === '/v1/monitoring') return json(response, 200, report);
                response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' }); response.end(prometheus(report)); return;
            }
            if (method === 'GET' && path === '/v1/overview') {
                const id = target.searchParams.get('factoryId');
                return json(response, 200, withAccess(await application.overview(id === null ? undefined : identifier(id, 'factoryId')), principal));
            }
            const taskPage = path.match(/^\/v1\/lines\/([^/]+)\/tasks$/);
            if (taskPage && method === 'GET') return json(response, 200, await application.taskPage(identifier(taskPage[1], 'lineId'), taskPageQuery(target.searchParams)));
            const interact = path.match(/^\/v1\/lines\/([^/]+)\/interaction$/);
            if (interaction && interact && method === 'POST') return json(response, 200, await interaction(identifier(interact[1], 'lineId'), await readJson(request), signal));
            if (intake && path === '/v1/intake') {
                if (method === 'GET') return json(response, 200, intake.list(target.searchParams.has('factoryId') ? identifier(target.searchParams.get('factoryId'), 'factoryId') : undefined));
                if (method === 'POST') return json(response, 201, intake.create(await readJson(request), requestKey(request) ?? ''));
            }
            const routing = path.match(/^\/v1\/factories\/([^/]+)\/routing$/);
            if (intake && routing) {
                const id = identifier(routing[1], 'factoryId');
                if (method === 'GET') return json(response, 200, intake.policy(id));
                if (method === 'PUT') return json(response, 200, intake.configure(id, await readJson(request)));
            }
            const destination = path.match(/^\/v1\/intake\/([^/]+)\/routing$/);
            if (intake && destination && method === 'PUT') return json(response, 200, intake.route(identifier(destination[1], 'taskId'), await readJson(request)));
            if (path === '/v1/factories') {
                if (method === 'GET')
                    return json(response, 200, withAccess(application.factories(), principal));
                if (method === 'POST')
                    return json(response, 201, application.createFactory(await readJson(request), requestKey(request)));
            }
            if (path === '/v1/lines') {
                if (method === 'GET')
                    return json(response, 200, application.lines());
                if (method === 'POST')
                    return json(response, 201, application.createLine(await readJson(request), requestKey(request)));
            }
            const match = path.match(/^\/v1\/(factories|lines)\/([^/]+)$/);
            if (match) {
                const id = identifier(match[2], 'id'), factory = match[1] === 'factories';
                if (method === 'GET')
                    return json(response, 200, factory ? application.factory(id) : application.line(id));
                if (method === 'PATCH')
                    return json(response, 200, factory ? application.updateFactory(id, await readJson(request), requestKey(request)) : application.updateLine(id, await readJson(request), requestKey(request)));
                if (method === 'DELETE')
                    return json(response, 200, factory ? application.deleteFactory(id, requestKey(request)) : application.deleteLine(id, requestKey(request)));
            }
            throw new DomainError('not_found', 'Unknown Factory endpoint');
        }
        catch (error) {
            // A disconnected upload is transport cancellation, not an application failure.
            if (request.aborted && response.destroyed && error instanceof Error && 'code' in error && error.code === 'ECONNRESET') return;
            const status = httpStatus(error);
            rejectRequest(request, response, status);
            json(response, status, { error: status < 500 && isExpectedError(error) ? error.message : 'Internal server error' });
            if (status >= 500 || !isExpectedError(error))
                reportError(error);
        }
    };
}
