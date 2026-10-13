import { AttemptLease } from './application/lease.js';
import { WorkerWorkspace } from './status/workspace.js';
import { serviceEvent } from '../shared/http/observability.js';
import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { type Task, type Profile, type Adapter, type WorkerPolicy } from '../shared/contracts.js';
import { statusServer, type Status } from './status/server.js';
import { SnapshotJournal } from './infrastructure/journal/snapshots.js';
import { atomicWrite, ensureDirectory, readBoundedFile } from './infrastructure/journal/files.js';
import { CodexAdapter, type CodexConfiguration } from './infrastructure/codex-adapter.js';
import { MockAdapter } from './infrastructure/mock-adapter.js';
import { HttpWorkerGateway, retryableTransportError } from './infrastructure/orchestrator-client.js';
import { loadOrRegisterIdentity, IdentityConfigurationError } from './infrastructure/identity.js';
import { executeAttempt } from './application/execute-attempt.js';
import type { WorkerGateway } from './application/ports.js';
export { MockAdapter } from './infrastructure/mock-adapter.js';
import { reportWithRetry as retryReport } from './application/reporting.js';
/** Backwards-compatible helper; application code consumes transport-independent failures. */
export function reportWithRetry<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return retryReport(operation, signal, retryableTransportError);
}
const taskInputText = (task: Task) => JSON.stringify({ project: task.project, title: task.title, criteria: task.criteria, wikilinks: task.wikilinks, provider: task.provider,
    executionMode: task.executionMode ?? 'mock', requirementRef: task.requirementRef, source: task.source, context: task.context, attempt: task.attempt }, null, 2);
export interface WorkerConfig {
    url?: string;
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
    chatExecutable?: string;
}
export interface WorkerDependencies {
    gateway?: WorkerGateway;
    adapter?: Adapter;
    now?: () => number;
}
export async function runWorker(config: WorkerConfig, stop: AbortSignal, dependencies: WorkerDependencies = {}) {
    if (config.policy.maxParallel !== 1 || config.profiles.some(profile => (profile.maxParallel ?? 1) !== 1))
        throw Error('A worker and each profile must have exactly one execution slot');
    if (config.retainedPairs !== undefined && (!Number.isSafeInteger(config.retainedPairs) || config.retainedPairs < 0 || config.retainedPairs > 100000))
        throw Error('retainedPairs must be an integer in 0–100000');
    const adapter = dependencies.adapter ?? (config.codex ? new CodexAdapter(config.codex, config.stateDir, config.systemPrompt) : new MockAdapter(config.mockMs));
    const now = dependencies.now ?? Date.now;
    await ensureDirectory(config.stateDir);
    const lock = join(config.stateDir, 'worker.lock');
    const handle = await open(lock, 'wx', 0o600).catch(() => { throw Error('State directory is locked. After a crash, verify the old process is stopped before deleting worker.lock.'); });
    const state: Status = { workerId: null, project: null, mode: adapter.mode, state: 'starting', taskId: null, attempt: null, profile: null, completedSimulations: 0, completedReviews: 0, lastContact: null, lastError: null, updatedAt: new Date(now()).toISOString(), profiles: config.profiles, heartbeatErrors: 0, maxParallel: config.policy.maxParallel, activeTasks: [], configurationHash: config.policy.configHash, lastSnapshot: null };
    const journal = new SnapshotJournal(config.stateDir, config.policy.configHash, config.systemPromptHash, config.projectDir, { maxParallel: config.policy.maxParallel, order: config.policy.order, maxAttempts: config.policy.maxAttempts, pollMs: config.pollMs, timeoutMs: config.timeoutMs }, config.retainedPairs);
    const workspace = new WorkerWorkspace({ ...config, chatExecutable: config.chatExecutable ?? config.codex?.executable }, journal, () => ({ ...state, outbox: journal.metrics(now()) }));
    const cancelSession = async (task: Task, explanation: string) => {
        const id = 'remote-' + task.id;
        try { await workspace.sessions.recordTask(id, taskInputText(task), explanation, true); }
        finally { await workspace.sessions.setTaskState(id, 'cancelled'); }
    };
    const shutdown = new AbortController(), stopping = AbortSignal.any([stop, shutdown.signal]);
    const running = new Map<string, {
        task: Task;
        promise: Promise<void>;
    }>();
    let connected = false;
    const waiting = new Map<string, { task: Task; lease: AttemptLease }>();
    let localTimer: ReturnType<typeof setInterval> | undefined;
    const operationalState = () => stopping.aborted ? 'stopping' : !workspace.settings.value.connection.enabled ? 'standalone' : !connected ? 'disconnected' : running.size ? 'executing' : 'idle';
    let status: Awaited<ReturnType<typeof statusServer>> | undefined, writing = Promise.resolve();
    const save = () => {
        state.updatedAt = new Date(now()).toISOString();
        state.queueCapacity = workspace.settings.value.board.orchestratorQueue;
        state.queuedTasks = [...waiting.values()].map(({ task }) => ({ id: task.id, profile: task.profile }));
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
        await workspace.init();
        status = await statusServer(() => ({ ...state, outbox: journal.metrics(now()) }), config.statusHost, config.statusPort, undefined, workspace);
        serviceEvent('worker', 'service_listening');
        // Keep the CLI's documented/discoverable ephemeral status endpoint available.
        console.error(JSON.stringify({ event: 'status_listening', address: status.address(), mode: adapter.mode, maxParallel: config.policy.maxParallel }));
        try { state.machineId = (await readBoundedFile(join(config.stateDir, 'machine-id'), 128)).trim(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; state.machineId = randomUUID(); await atomicWrite(join(config.stateDir, 'machine-id'), state.machineId); }
        localTimer = setInterval(() => { workspace.executor.wake(); void workspace.board.tick().catch(() => { serviceEvent('worker', 'state_write_error', 'error'); }); }, 250);
        let session: { url: string; identity: import('./application/ports.js').WorkerIdentity; client: import('./application/ports.js').WorkerClient } | undefined;
        let requestId = randomUUID();
        while (!stopping.aborted) {
            try {
                const connection = workspace.settings.value.connection;
                if (!connection.enabled) {
                    connected = false; state.state = 'standalone'; state.lastError = null; await save();
                } else {
                    if (!session) {
                        const gateway = dependencies.gateway ?? new HttpWorkerGateway(connection.url, connection.enrollmentToken);
                        const identity = await loadOrRegisterIdentity(config.stateDir, connection.url, config.profiles, config.policy, gateway, stopping);
                        await journal.recover(identity.id, config.profiles, state);
                        session = { url: connection.url, identity, client: gateway.connect(identity) };
                        state.workerId = identity.id; state.project = identity.project;
                    }
                    const { client, identity } = session;
                    await journal.flush(snapshot => client.publishSnapshot(snapshot));
                    const accept = async (task: Task) => {
                        if (!task.lease || running.has(task.lease) || waiting.has(task.lease) || (task.expiresAt ?? 0) <= now()) return;
                        await workspace.rememberTask(task);
                        const lease = new AttemptLease(task, client, state, now);
                        try {
                            await workspace.sessions.prepareTask('remote-' + task.id, taskInputText(task));
                            await workspace.sessions.setTaskState('remote-' + task.id, 'queued');
                            await lease.start(); waiting.set(task.lease, { task, lease });
                        } catch (error) {
                            await lease.close();
                            // Acceptance failed before entering the waiting map; no later poll can reconcile this session.
                            await cancelSession(task, 'The remote assignment could not be accepted. No execution started; inspect worker status and orchestrator events.');
                            throw error;
                        }
                    };
                    const current = await client.currentAssignments();
                    for (const [id, entry] of waiting) if (entry.lease.signal.aborted || !current.some(task => task.lease === id)) { await entry.lease.close(); waiting.delete(id); await cancelSession(entry.task, 'The assignment lease expired or was withdrawn before execution.'); }
                    for (const task of current) await accept(task);
                    const board = workspace.settings.value.board;
                    {
                        const capacity = config.policy.maxParallel + board.orchestratorQueue;
                        for (let n = 0; n < capacity && !board.paused && running.size + waiting.size < capacity && !stopping.aborted; n++) {
                            const task = await client.claim(requestId, board.orchestratorQueue); requestId = randomUUID();
                            if (!task) break; await accept(task);
                        }
                        const pending = [...waiting.entries()].sort(([, a], [, b]) => (board.order === 'priority' ? b.task.priority - a.task.priority : 0) || a.task.createdAt - b.task.createdAt);
                        for (const [id, entry] of pending) {
                            if (running.size || stopping.aborted || workspace.settings.value.board.paused || workspace.executor.busy) break;
                            const task = entry.task, sessionId = 'remote-' + task.id;
                            const release = await workspace.executor.acquire(sessionId, AbortSignal.any([stopping, entry.lease.signal]));
                            // Keep renewing while another task owns the shared worker permit.
                            if (stopping.aborted || entry.lease.signal.aborted || workspace.settings.value.board.paused) { release(); continue; }
                            try {
                                await entry.lease.close();
                                if (stopping.aborted || workspace.settings.value.board.paused) {
                                    if (!stopping.aborted) {
                                        const lease = new AttemptLease(task, client, state, now);
                                        try { await lease.start(); waiting.set(id, { task, lease }); }
                                        catch (error) { await lease.close(); throw error; }
                                    }
                                    release(); continue;
                                }
                            } catch (error) { release(); throw error; }
                            waiting.delete(id);
                            if (entry.lease.signal.aborted) { release(); await cancelSession(task, 'The assignment lease expired before execution.'); continue; }
                            const input = taskInputText(task);
                            const promise = Promise.resolve().then(async () => {
                                await workspace.sessions.setTaskState(sessionId, 'running');
                                const terminal = await executeAttempt(task, stopping, { client, journal, adapter, identity, profiles: config.profiles, state, saveState: save, timeoutMs: config.timeoutMs, now });
                                const failed = !['simulated', 'change-set'].includes(terminal.execution.outcome);
                                await workspace.sessions.recordTask(sessionId, input, JSON.stringify({ execution: terminal.execution, review: terminal.review ?? null, quality: terminal.quality, provenance: terminal.provenance }, null, 2), failed);
                                await workspace.sessions.setTaskState(sessionId, terminal.execution.outcome === 'interrupted' ? 'cancelled' : failed ? 'failed' : 'completed');
                              })
                              .catch(async error => {
                                state.lastError = error.message; serviceEvent('worker', 'attempt_error', 'error');
                                await workspace.sessions.recordTask(sessionId, input, 'The attempt was interrupted or could not finish acknowledgement. Inspect its snapshots and orchestrator events before retrying.', true);
                                await workspace.sessions.setTaskState(sessionId, stopping.aborted ? 'cancelled' : 'failed');
                              })
                              .finally(async () => { release(); running.delete(id); state.state = operationalState(); await save(); })
                              .catch(() => { serviceEvent('worker', 'state_write_error', 'error'); });
                            running.set(id, { task, promise });
                        }
                    }
                    state.lastContact = new Date(now()).toISOString();
                    if (!connected) serviceEvent('worker', 'connection_restored');
                    connected = true; state.state = operationalState(); await save();
                }
            } catch (error) {
                if (error instanceof IdentityConfigurationError) throw error;
                if (connected) serviceEvent('worker', 'connection_lost', 'warn');
                connected = false; state.state = operationalState();
                state.lastError = (error as Error).message; await save();
            }
            try { await delay(config.pollMs + Math.random() * 250, undefined, { signal: stopping }); }
            catch { break; }
        }
    }
    finally {
        shutdown.abort();
        state.state = 'stopping';
        if (localTimer) clearInterval(localTimer);
        await workspace.close();
        await Promise.allSettled([...waiting.values()].map(async entry => { await entry.lease.close(); await cancelSession(entry.task, 'The worker stopped before this queued assignment executed.'); }));
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
