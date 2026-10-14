import { serveWebviewAsset } from '../shared/http/webview-assets.js';
import { privateJson } from '../shared/http/bounded-client.js';
import { FactoryIntake } from './application/intake.js';
import { SqliteIntakeStore } from './infrastructure/intake-store.js';
import { HttpLineDelivery } from './infrastructure/delivery.js';
import { loadAccessFile, accessAuthorization, type AccessDocument } from '../shared/http/access.js';
import type { AuditSink } from '../shared/http/audit.js';
import { monitoringThresholds, type MonitoringThresholds } from '../shared/monitoring.js';
import { createServer } from 'node:http';
import { observeHttp, serviceEvent } from '../shared/http/observability.js';
import { readFile } from 'node:fs/promises';
import { DomainError } from '../shared/errors.js';
import { LINE_TOKEN_PATTERN } from '../shared/factory.js';
import { SqliteFactoryRegistry } from './infrastructure/registry.js';
import { managedRegistry, type ManagedRegistry } from './application/managed-registry.js';
import { FactoryApplication } from './application/service.js';
import { HttpLineReader } from './infrastructure/poller.js';
import { createFactoryHandler } from './http.js';
export interface FactoryServerConfig {
    managedRegistry?: ManagedRegistry;
    db: string;
    host: string;
    port: number;
    adminToken: string;
  access?: AccessDocument;
  accessFile?: string;
  audit?: AuditSink;
  monitoring?: MonitoringThresholds;
    credentials?: Record<string, string | undefined>;
    pollTimeoutMs?: number;
    pollConcurrency?: number;
}
export async function startFactoryServer(config: FactoryServerConfig) {
    const managed = managedRegistry(config.managedRegistry);
    if (typeof config.adminToken !== 'string' || config.adminToken.length < 24)
        throw new DomainError('invalid_input', 'Set WERK_FACTORY_ADMIN_TOKEN to at least 24 characters');
    if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)
        throw new DomainError('invalid_input', 'port: integer 0–65535');
    const timeout = config.pollTimeoutMs ?? 3000, concurrency = config.pollConcurrency ?? 4;
    if (!Number.isInteger(timeout) || timeout < 50 || timeout > 30000 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
        throw new DomainError('invalid_input', 'Polling timeout 50–30000 ms and concurrency 1–16 required');
    const access = config.access ?? await loadAccessFile(config.accessFile ?? process.env.WERK_ACCESS_FILE);
    accessAuthorization(config.adminToken, access);
    const monitoring = config.monitoring ?? monitoringThresholds(process.env);
    const credentials: Record<string, string> = {};
    for (const [name, value] of Object.entries(config.credentials ?? process.env))
        if (LINE_TOKEN_PATTERN.test(name) && value) {
            if (value === config.adminToken)
                throw new DomainError('invalid_input', 'Factory admin and production line credentials must be distinct');
            credentials[name] = value;
        }
    accessAuthorization(config.adminToken, access, Object.values(credentials));
    const view = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
    const guide = await readFile(new URL('./public/guide.html', import.meta.url), 'utf8');
    const registry = new SqliteFactoryRegistry(config.db), reader = new HttpLineReader(credentials, timeout, concurrency);
    const application = new FactoryApplication(registry, reader, new Set(Object.keys(credentials)), Date.now, monitoring, managed);
    const intakeStore = new SqliteIntakeStore(config.db === ':memory:' ? ':memory:' : config.db + '.intake.sqlite');
    const intake = new FactoryIntake(registry, reader, intakeStore, new HttpLineDelivery(credentials));
    application.protectIntake((type, id) => intake.assertRemoval(type, id));
    const handler = createFactoryHandler(application, config.adminToken, view, () => serviceEvent('factory', 'internal_error', 'error'), guide, access, config.audit, intake, async (id, input) => { const line = registry.line(id); const credential = credentials[line.tokenEnv]; if (!credential) throw new DomainError('unavailable', 'Line credential unavailable'); return privateJson(new URL('/v1/interaction', line.orchestratorUrl), credential, 'POST', input); });
    const server = createServer(observeHttp('factory', async (request, response) => {
      if (await serveWebviewAsset(request, response, new URL('./public/', import.meta.url))) return;
      await handler(request, response);
    }));
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    try {
        await new Promise<void>((resolve, reject) => { const failed = (error: Error) => reject(error); server.once('error', failed); server.listen(config.port, config.host, () => { server.off('error', failed); resolve(); }); });
    }
    catch (error) {
        await intake.close(); intakeStore.close();
        reader.close();
        registry.close();
        throw error;
    }
    const dispatch = setInterval(() => { void intake.tick().catch(() => serviceEvent('factory', 'intake_error', 'error')); }, 2000).unref();
    let closing: Promise<void> | undefined;
    return { server, registry, application, intake, close: () => {
            if (closing)
                return closing;
            clearInterval(dispatch);
            reader.close();
            const drained = new Promise<void>((resolve, reject) => {
                const deadline = setTimeout(() => server.closeAllConnections(), 5000).unref();
                server.close(error => { clearTimeout(deadline); error ? reject(error) : resolve(); });
                server.closeIdleConnections();
            });
            closing = Promise.all([drained, intake.close()]).then(() => { intakeStore.close(); registry.close(); });
            return closing;
        } };
}
