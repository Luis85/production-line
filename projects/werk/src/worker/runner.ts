import { serviceEvent } from '../shared/http/observability.js';
import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { type Task, type Profile, type Adapter, type WorkerPolicy } from '../shared/contracts.js';
import { statusServer, type Status } from './status/server.js';
import { SnapshotJournal } from './infrastructure/journal/snapshots.js';
import { atomicWrite, ensureDirectory } from './infrastructure/journal/files.js';
import { CodexAdapter, type CodexConfiguration } from './infrastructure/codex-adapter.js';
import { MockAdapter } from './infrastructure/mock-adapter.js';
import { HttpWorkerGateway, retryableTransportError } from './infrastructure/orchestrator-client.js';
import { loadOrRegisterIdentity } from './infrastructure/identity.js';
import { executeAttempt } from './application/execute-attempt.js';
import type { WorkerGateway } from './application/ports.js';
export { MockAdapter } from './infrastructure/mock-adapter.js';
import { reportWithRetry as retryReport } from './application/reporting.js';
/** Backwards-compatible helper; application code consumes transport-independent failures. */
export function reportWithRetry<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return retryReport(operation, signal, retryableTransportError);
}
export interface WorkerConfig {
    url: string;
    stateDir: string;
    enrollmentToken: string;
    profiles: Profile[];
    statusHost: string;
    statusPort: number;
    pollMs: number;
    mockMs: number;
    timeoutMs: number;
    policy: WorkerPolicy;
    systemPromptHash: string;
    systemPrompt: string;
    projectDir?: string;
    retainedPairs?: number;
    codex?: CodexConfiguration;
}
export interface WorkerDependencies {
    gateway?: WorkerGateway;
    adapter?: Adapter;
    now?: () => number;
}
export async function runWorker(config: WorkerConfig, stop: AbortSignal, dependencies: WorkerDependencies = {}) {
    if (config.retainedPairs !== undefined && (!Number.isSafeInteger(config.retainedPairs) || config.retainedPairs < 0 || config.retainedPairs > 100000))
        throw Error('retainedPairs must be an integer in 0–100000');
    const gateway = dependencies.gateway ?? new HttpWorkerGateway(config.url, config.enrollmentToken);
    const adapter = dependencies.adapter ?? (config.codex ? new CodexAdapter(config.codex, config.stateDir, config.systemPrompt) : new MockAdapter(config.mockMs));
    const now = dependencies.now ?? Date.now;
    await ensureDirectory(config.stateDir);
    const lock = join(config.stateDir, 'worker.lock');
    const handle = await open(lock, 'wx', 0o600).catch(() => { throw Error('State directory is locked. After a crash, verify the old process is stopped before deleting worker.lock.'); });
    const state: Status = { workerId: null, project: null, mode: adapter.mode, state: 'starting', taskId: null, attempt: null, profile: null, completedSimulations: 0, completedReviews: 0, lastContact: null, lastError: null, updatedAt: new Date(now()).toISOString(), profiles: config.profiles, heartbeatErrors: 0, maxParallel: config.policy.maxParallel, activeTasks: [], configurationHash: config.policy.configHash, lastSnapshot: null };
    const journal = new SnapshotJournal(config.stateDir, config.policy.configHash, config.systemPromptHash, config.projectDir, { maxParallel: config.policy.maxParallel, order: config.policy.order, maxAttempts: config.policy.maxAttempts, pollMs: config.pollMs, timeoutMs: config.timeoutMs }, config.retainedPairs);
    const shutdown = new AbortController(), stopping = AbortSignal.any([stop, shutdown.signal]);
    const running = new Map<string, {
        task: Task;
        promise: Promise<void>;
    }>();
    let connected = false;
    const operationalState = () => stopping.aborted ? 'stopping' : !connected ? 'disconnected' : running.size ? 'executing' : 'idle';
    let status: Awaited<ReturnType<typeof statusServer>> | undefined, writing = Promise.resolve();
    const save = () => {
        state.updatedAt = new Date(now()).toISOString();
        state.activeTasks = [...running.values()].map(({ task }) => ({ id: task.id, attempt: task.attempt, profile: task.profile }));
        const first = state.activeTasks[0];
        state.taskId = first?.id ?? null;
        state.attempt = first?.attempt ?? null;
        state.profile = first?.profile ?? null;
        const body = JSON.stringify(state, null, 2);
        writing = writing.catch(() => { }).then(() => atomicWrite(join(config.stateDir, 'status.json'), body));
        return writing;
    };
    try {
        await handle.writeFile(String(process.pid));
        await handle.sync();
        await handle.close();
        await journal.init();
        status = await statusServer(() => ({ ...state, outbox: journal.metrics(now()) }), config.statusHost, config.statusPort);
        serviceEvent('worker', 'service_listening');
        // Keep the CLI's documented/discoverable ephemeral status endpoint available.
        console.error(JSON.stringify({ event: 'status_listening', address: status.address(), mode: adapter.mode, maxParallel: config.policy.maxParallel }));
        const identity = await loadOrRegisterIdentity(config.stateDir, config.url, config.profiles, config.policy, gateway, stopping);
        const client = gateway.connect(identity);
        state.workerId = identity.id;
        state.project = identity.project;
        const flush = () => journal.flush(snapshot => client.publishSnapshot(snapshot));
        await journal.recover(identity.id, config.profiles, state);
        const execute = (task: Task) => executeAttempt(task, stopping, {
            client, journal, adapter, identity, profiles: config.profiles, state, saveState: save, timeoutMs: config.timeoutMs, now
        });
        const launch = (task: Task) => {
            if (!task.lease || running.has(task.lease) || running.size >= config.policy.maxParallel || stopping.aborted)
                return;
            const lease = task.lease;
            const promise = Promise.resolve().then(() => execute(task)).catch(error => {
                state.lastError = error.message;
                serviceEvent('worker', 'attempt_error', 'error');
            }).finally(async () => {
                running.delete(lease);
                state.state = operationalState();
                await save();
            }).catch(error => { state.lastError = error.message; serviceEvent('worker', 'state_write_error', 'error'); });
            running.set(lease, { task, promise });
        };
        let requestId = randomUUID();
        while (!stopping.aborted) {
            try {
                await flush();
                const current = await client.currentAssignments();
                for (const task of current)
                    if ((task.expiresAt ?? 0) > now())
                        launch(task);
                for (let n = 0; n < config.policy.maxParallel && running.size < config.policy.maxParallel && !stopping.aborted; n++) {
                    const task = await client.claim(requestId);
                    requestId = randomUUID();
                    if (!task)
                        break;
                    launch(task);
                }
                state.lastContact = new Date(now()).toISOString();
                if (!connected) serviceEvent('worker', 'connection_restored');
                connected = true;
                state.state = operationalState();
                await save();
            }
            catch (error) {
                if (connected) serviceEvent('worker', 'connection_lost', 'warn');
                connected = false;
                state.state = operationalState();
                state.lastError = (error as Error).message;
                await save();
            }
            try {
                await delay(config.pollMs + Math.random() * 250, undefined, { signal: stopping });
            }
            catch {
                break;
            }
        }
    }
    finally {
        shutdown.abort();
        state.state = 'stopping';
        await Promise.allSettled([...running.values()].map(x => x.promise));
        journal.close();
        state.state = 'stopped';
        try {
            await save();
        }
        finally {
            try {
                if (status) {
                    const server = status;
                    await new Promise<void>(resolve => {
                        // A partial status request must not keep the worker lock alive past the supervisor's grace period.
                        const deadline = setTimeout(() => server.closeAllConnections(), 5000).unref();
                        server.close(() => { clearTimeout(deadline); resolve(); });
                        server.closeIdleConnections();
                    });
                }
            }
            finally {
                await handle.close().catch(() => { });
                await unlink(lock);
            }
        }
    }
}
