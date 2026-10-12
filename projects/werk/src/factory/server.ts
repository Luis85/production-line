import { loadAccessFile, accessAuthorization, type AccessDocument } from '../shared/http/access.js';
import type { AuditSink } from '../shared/http/audit.js';
import { monitoringThresholds, type MonitoringThresholds } from '../shared/monitoring.js';
import { createServer } from 'node:http';
import { observeHttp, serviceEvent } from '../shared/http/observability.js';
import { readFile } from 'node:fs/promises';
import { DomainError } from '../shared/errors.js';
import { LINE_TOKEN_PATTERN } from '../shared/factory.js';
import { SqliteFactoryRegistry } from './infrastructure/registry.js';
import { FactoryApplication } from './application/service.js';
import { HttpLineReader } from './infrastructure/poller.js';
import { createFactoryHandler } from './http.js';
export interface FactoryServerConfig {
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
    const application = new FactoryApplication(registry, reader, new Set(Object.keys(credentials)), Date.now, monitoring);
    const server = createServer(observeHttp('factory', createFactoryHandler(application, config.adminToken, view, () => serviceEvent('factory', 'internal_error', 'error'), guide, access, config.audit)));
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    try {
        await new Promise<void>((resolve, reject) => { const failed = (error: Error) => reject(error); server.once('error', failed); server.listen(config.port, config.host, () => { server.off('error', failed); resolve(); }); });
    }
    catch (error) {
        reader.close();
        registry.close();
        throw error;
    }
    let closing: Promise<void> | undefined;
    return { server, registry, application, close: () => {
            if (closing)
                return closing;
            reader.close();
            closing = new Promise<void>((resolve, reject) => {
                // Stop accepting requests first; a partial upload must not outlive the deployment grace period.
                const deadline = setTimeout(() => server.closeAllConnections(), 5000).unref();
                server.close(error => {
                    clearTimeout(deadline);
                    try {
                        registry.close();
                        error ? reject(error) : resolve();
                    } catch (closeError) { reject(closeError); }
                });
                server.closeIdleConnections();
            });
            return closing;
        } };
}
