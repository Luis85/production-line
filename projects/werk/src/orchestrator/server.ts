import { serveWebviewAsset } from '../shared/http/webview-assets.js';
import { loadAccessFile, accessAuthorization, type AccessDocument } from '../shared/http/access.js';
import type { AuditSink } from '../shared/http/audit.js';
import { monitoringThresholds, type MonitoringThresholds } from '../shared/monitoring.js';
import { createServer } from 'node:http';
import { observeHttp, serviceEvent } from '../shared/http/observability.js';
import { readFile } from 'node:fs/promises';
import { identifier } from '../shared/contracts.js';
import { DomainError } from '../shared/errors.js';
import { SCHEMA_VERSION } from './persistence/schema.js';
import { Store } from './persistence/store.js';
import { OrchestratorApplication } from './application.js';
import { createHttpHandler, tokenAuthorization } from './http.js';
import { BoundContextIntake, type ContextBinding } from './context/intake.js';

export interface ServerConfig {
  db: string;
  host: string;
  port: number;
  adminToken: string;
  access?: AccessDocument;
  accessFile?: string;
  audit?: AuditSink;
  monitoring?: MonitoringThresholds;
  enrollmentToken: string;
  project: string;
  leaseMs?: number;
  shutdownTimeoutMs?: number;
  context?: ContextBinding;
}

/** Composition root: constructs adapters, owns listening and releases every resource. */
export async function startServer(config: ServerConfig) {
  if (config.adminToken.length < 24 || config.enrollmentToken.length < 24 || config.adminToken === config.enrollmentToken) {
    throw new DomainError('invalid_input', 'Set distinct WERK_ADMIN_TOKEN and WERK_ENROLLMENT_TOKEN, each at least 24 characters');
  }
  identifier(config.project, 'project');
  const shutdownTimeoutMs = config.shutdownTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 60000) {
    throw new DomainError('invalid_input', 'shutdownTimeoutMs: integer 1–60000');
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new DomainError('invalid_input', 'port: integer 0–65535');
  }
  const access = config.access ?? await loadAccessFile(config.accessFile ?? process.env.WERK_ACCESS_FILE);
  accessAuthorization(config.adminToken, access, [config.enrollmentToken]);
  const monitoring = config.monitoring ?? monitoringThresholds(process.env);
  const contextIntake = config.context ? new BoundContextIntake(config.project, config.context) : undefined;
  const [intake, concept, guide] = await Promise.all(
    ['index.html', 'concept.html', 'guide.html'].map(file => readFile(new URL('./public/' + file, import.meta.url), 'utf8')),
  );
  const store = new Store(config.db, config.leaseMs);
  const application = new OrchestratorApplication(store, config.project, contextIntake, monitoring);
  const handler = createHttpHandler({
    application,
    schemaVersion: SCHEMA_VERSION,
    authorize: tokenAuthorization(config.adminToken, config.enrollmentToken, access),
    audit: config.audit,
    views: { intake, concept, guide },
    reportError: () => serviceEvent('orchestrator', 'internal_error', 'error'),
  });
  const server = createServer(observeHttp('orchestrator', async (request, response) => {
    if (await serveWebviewAsset(request, response, new URL('./public/', import.meta.url))) return;
    await handler(request, response);
  }));
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 1000;
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      server.once('error', failed);
      server.listen(config.port, config.host, () => {
        server.off('error', failed);
        resolve();
      });
    });
  } catch (error) {
    await contextIntake?.close();
    store.close();
    throw error;
  }

  const reaper = setInterval(() => {
    try { store.reapExpired(); }
    catch (error) {
      serviceEvent('orchestrator', 'lease_reaper_error', 'error');
    }
  }, Math.max(10, Math.min(1000, store.ttl))).unref();

  let closing: Promise<void> | undefined;
  return {
    server,
    store,
    close: () => {
      if (closing) return closing;
      clearInterval(reaper);
      const contextClosed = contextIntake?.close() ?? Promise.resolve();
      closing = new Promise<void>((resolve, reject) => {
        // Active or partially uploaded requests must not indefinitely hold the process and database open.
        const deadline = setTimeout(() => server.closeAllConnections(), shutdownTimeoutMs).unref();
        server.close(error => {
          clearTimeout(deadline);
          void contextClosed.then(() => {
            try {
              store.close();
              error ? reject(error) : resolve();
            } catch (closeError) { reject(closeError); }
          }, reject);
        });
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}
