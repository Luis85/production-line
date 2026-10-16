import { validateWorkerInteractionResponse } from '../shared/worker-interaction.js';
import { settleCleanup } from '../shared/lifecycle.js';
import { drainHttpServer, HttpRequestLifecycle, trackHttpRequests } from '../shared/http/server-lifecycle.js';
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
    const requests = new HttpRequestLifecycle();
    let registry: SqliteFactoryRegistry | undefined;
    let reader: HttpLineReader | undefined;
    let intakeStore: SqliteIntakeStore | undefined;
    let intake: FactoryIntake | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    let dispatch: ReturnType<typeof setInterval> | undefined;
    let closing: Promise<void> | undefined;
    const close = () => {
      if (closing) return closing;
      if (dispatch) clearInterval(dispatch);
      // Stop admission and start the configured grace period at the close call, before any await.
      const drained = drainHttpServer(server);
      return closing = settleCleanup(
        [() => reader?.close(), () => drained, () => intake?.close()],
        () => intakeStore?.close(),
        () => registry?.close(),
      );
    };
    try {
        registry = new SqliteFactoryRegistry(config.db);
        reader = new HttpLineReader(credentials, timeout, concurrency);
        const application = new FactoryApplication(registry, reader, new Set(Object.keys(credentials)), Date.now, monitoring, managed);
        intakeStore = new SqliteIntakeStore(config.db === ':memory:' ? ':memory:' : config.db + '.intake.sqlite');
        intake = new FactoryIntake(registry, reader, intakeStore, new HttpLineDelivery(credentials));
        const activeIntake = intake, activeRegistry = registry;
        application.protectIntake((type, id) => activeIntake.assertRemoval(type, id));
        const handler = createFactoryHandler(application, config.adminToken, view, () => serviceEvent('factory', 'internal_error', 'error'), guide, access, config.audit, intake, async (id, input, signal) => { const line = activeRegistry.line(id); const credential = credentials[line.tokenEnv]; if (!credential) throw new DomainError('unavailable', 'Line credential unavailable'); return validateWorkerInteractionResponse(await privateJson(new URL('/v1/interaction', line.orchestratorUrl), credential, 'POST', input, { signal })); });
        server = createServer(observeHttp('factory', requests.wrap(async (request, response, signal) => {
          if (await serveWebviewAsset(request, response, new URL('./public/', import.meta.url))) return;
          await handler(request, response, signal);
        })));
        trackHttpRequests(server, requests);
        server.requestTimeout = 15000;
        server.headersTimeout = 10000;
        await new Promise<void>((resolve, reject) => {
            const listening = server!;
            const failed = (error: Error) => reject(error);
            listening.once('error', failed);
            listening.listen(config.port, config.host, () => { listening.off('error', failed); resolve(); });
        });
        dispatch = setInterval(() => { void activeIntake.tick().catch(() => serviceEvent('factory', 'intake_error', 'error')); }, 2000).unref();
        return { server, registry, application, intake, close };
    } catch (error) {
        await close().catch(() => {});
        throw error;
    }
}
