import { settleCleanup, withCleanup, type CleanupStep } from '../shared/lifecycle.js';
import { drainHttpServer } from '../shared/http/server-lifecycle.js';
import { ExecutionProfiles, type ExecutionProfilesView } from './application/execution-profiles.js';
import { executionProfilesStorage } from './infrastructure/execution-profiles.js';
import { DomainError } from '../shared/errors.js';
import type { RepositoryConfiguration } from './application/repositories.js';
import { verifyReviewArtifact } from "./infrastructure/review-artifact.js";
import { RemoteGateReconciler } from "./application/reconcile-request-gates.js";
import { RemoteRequestGates } from "./application/remote-request-gates.js";
import { AttemptLease } from "./application/lease.js";
import { WorkerWorkspace } from "./status/workspace.js";
import { serviceEvent } from "../shared/http/observability.js";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Task,
  type Profile,
  type Adapter,
  type WorkerPolicy,
} from "../shared/contracts.js";
import { statusServer, type Status } from "./status/server.js";
import { SnapshotJournal } from "./infrastructure/journal/snapshots.js";
import {
  atomicWrite,
  ensureDirectory,
  readBoundedFile,
} from "./infrastructure/journal/files.js";
import {
  CodexAdapter,
  type CodexConfiguration,
} from "./infrastructure/codex-adapter.js";
import { MockAdapter } from "./infrastructure/mock-adapter.js";
import {
  HttpWorkerGateway,
  retryableTransportError,
} from "./infrastructure/orchestrator-client.js";
import {
  loadOrRegisterIdentity,
  readRegisteredIdentity,
  IdentityConfigurationError,
} from "./infrastructure/identity.js";
import { executeAttempt } from "./application/execute-attempt.js";
import type { WorkerGateway } from "./application/ports.js";
export { MockAdapter } from "./infrastructure/mock-adapter.js";
import { reportWithRetry as retryReport } from "./application/reporting.js";
/** Backwards-compatible helper; application code consumes transport-independent failures. */
export function reportWithRetry<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return retryReport(operation, signal, retryableTransportError);
}
const taskInputText = (task: Task) =>
  JSON.stringify(
    {
      project: task.project,
      repository: task.repository,
      title: task.title,
      criteria: task.criteria,
      wikilinks: task.wikilinks,
      provider: task.provider,
      executionMode: task.executionMode ?? "mock",
      requirementRef: task.requirementRef,
      source: task.source,
      context: task.context,
      attempt: task.attempt,
    },
    null,
    2,
  );
export interface WorkerConfig {
  url?: string;
  stateDir: string;
  enrollmentToken: string;
  /** Private local access token; never included in public status. */
  webviewToken?: string;
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
  integrationProjectDir?: string;
  repositories?: RepositoryConfiguration;
  features?: { directory: string; provider: string; pollMs: number };
  retainedPairs?: number;
  codex?: CodexConfiguration;
  chatExecutable?: string;
}
export interface WorkerDependencies {
  ready?: (address: { port: number; address: string }) => Promise<void>;
  gateway?: WorkerGateway;
  adapter?: Adapter;
  now?: () => number;
}
export async function runWorker(
  config: WorkerConfig,
  stop: AbortSignal,
  dependencies: WorkerDependencies = {},
) {
  if (
    config.policy.maxParallel !== 1 ||
    config.profiles.some((profile) => (profile.maxParallel ?? 1) !== 1)
  )
    throw Error(
      "A worker and each profile must have exactly one execution slot",
    );
  if (
    config.retainedPairs !== undefined &&
    (!Number.isSafeInteger(config.retainedPairs) ||
      config.retainedPairs < 0 ||
      config.retainedPairs > 100000)
  )
    throw Error("retainedPairs must be an integer in 0–100000");
  config = { ...config, profiles: structuredClone(config.profiles), policy: { ...config.policy } };
  await ensureDirectory(config.stateDir);
  const lock = join(config.stateDir, "worker.lock");
  const handle = await open(lock, "wx", 0o600).catch(() => {
    throw Error(
      "State directory is locked. After a crash, verify the old process is stopped before deleting worker.lock.",
    );
  });
  const cleanup: CleanupStep[] = [
    () => handle.close(),
    () => unlink(lock),
  ];
  return withCleanup(
    () => runLockedWorker(config, stop, dependencies, handle, cleanup),
    () => settleCleanup(...cleanup),
  );
}

/** The lock scope covers constructors as well as asynchronous startup and execution. */
async function runLockedWorker(
  config: WorkerConfig,
  stop: AbortSignal,
  dependencies: WorkerDependencies,
  handle: FileHandle,
  cleanup: CleanupStep[],
) {
  const mode = dependencies.adapter?.mode ?? (config.codex ? "cli" : "mock");
  const executionProfiles = new ExecutionProfiles(config.policy.configHash, config.profiles, mode, executionProfilesStorage(config.stateDir));
  const now = dependencies.now ?? Date.now;
  const state: Status = {
    workerId: null,
    project: null,
    mode,
    state: "starting",
    taskId: null,
    attempt: null,
    profile: null,
    completedSimulations: 0,
    completedReviews: 0,
    lastContact: null,
    lastError: null,
    updatedAt: new Date(now()).toISOString(),
    profiles: config.profiles,
    heartbeatErrors: 0,
    maxParallel: config.policy.maxParallel,
    activeTasks: [],
    configurationHash: config.policy.configHash,
    lastSnapshot: null,
  };
  const journal = new SnapshotJournal(
    config.stateDir,
    config.policy.configHash,
    config.systemPromptHash,
    config.projectDir,
    {
      maxParallel: config.policy.maxParallel,
      order: config.policy.order,
      maxAttempts: config.policy.maxAttempts,
      pollMs: config.pollMs,
      timeoutMs: config.timeoutMs,
    },
    config.retainedPairs,
  );
  cleanup.unshift(() => journal.close());
  let session:
    | { url: string; identity: import('./application/ports.js').WorkerIdentity; client: import('./application/ports.js').WorkerClient }
    | undefined;
  let requestId = randomUUID();
  const profileView = (): ExecutionProfilesView => {
    const pending = Boolean(executionProfiles.pending);
    const saveBlockedReason = pending ? 'Saved profiles are waiting for the orchestrator. Keep intake paused until they are applied.'
      : !workspace.settings.value.board.paused ? 'Pause intake before editing execution profiles.'
      : workspace.sessions.busy || workspace.board.active || state.activeTasks.length || state.queuedTasks?.length
        ? 'Finish or cancel queued tasks and active replies before editing execution profiles.' : null;
    return { ...executionProfiles.view(), canEdit: !saveBlockedReason, saveBlockedReason };
  };
  const applyProfileState = () => {
    const active = executionProfiles.active;
    config.profiles = active.profiles;
    config.policy.configHash = active.configurationHash;
    state.profiles = active.profiles;
    state.configurationHash = active.configurationHash;
    journal.configHash = active.configurationHash;
    requestId = randomUUID();
  };
  const workspace: WorkerWorkspace = new WorkerWorkspace(
    {
      ...config,
      executionProfiles: {
        view: profileView,
        pending: () => Boolean(executionProfiles.pending),
        update: async (input) => workspace.withIdleConfiguration(async () => {
          const registered = session?.identity ?? await readRegisteredIdentity(config.stateDir);
          // A failed terminal write can outlive its lease. Finish recovery under the old profile authority first.
          if (registered) await journal.recover(registered.id, config.profiles, state, before => remoteGates(registered.url).recoverSnapshot(before));
          await executionProfiles.stage(input);
          if (executionProfiles.pending && !registered) { await executionProfiles.commit(); applyProfileState(); }
          await save();
          return profileView();
        }),
      },
      chatExecutable: config.chatExecutable ?? config.codex?.executable,
    },
    journal,
    () => ({ ...state, outbox: journal.metrics(now()) }),
  );
  let workspaceClosing: Promise<void> | undefined, evidenceClosing: Promise<void> | undefined;
  const closeWorkspace = () => workspaceClosing ??= workspace.close({ deferEvidence: true });
  const closeEvidence = () => evidenceClosing ??= workspace.closeEvidence();
  // Also covers failures constructing the execution adapter before the main loop starts.
  cleanup.unshift(closeWorkspace, closeEvidence);
  const repositoryScope = () => {
    const repositoryIds = workspace.settings.value.repositories.items.map(item => item.id);
    return {
      repositoryIds,
      legacyRepository: mode === "cli" && repositoryIds.length === 0 && Boolean(config.codex?.repository) && workspace.repositoryDiscovery.legacyAllowed(),
    };
  };
  const adapter = dependencies.adapter ?? (config.codex
    ? new CodexAdapter(config.codex, config.stateDir, config.systemPrompt, workspace.repositories, path => workspace.repositoryDiscovery.assertAllowed(path), workspace.consumption)
    : new MockAdapter(config.mockMs));
  const gateReconciler = new RemoteGateReconciler(
    workspace.sessions.requests,
    journal,
    async (snapshot) => {
      if (!snapshot.review) throw Error("Review artifact is unavailable");
      await verifyReviewArtifact(
        config.stateDir,
        snapshot.pairId,
        snapshot.review,
      );
    },
  );
  const remoteGates = (origin: string) =>
    new RemoteRequestGates(
      workspace.sessions.requests,
      origin,
      (assigned) => {
        const provider = workspace.settings.provider(
          assigned.provider === "claude" ? "claude-cli" : "codex-cli",
        );
        return {
          id: provider.id,
          model: provider.model,
          instruction: provider.instruction ?? "",
        };
      },
      config.codex?.allowedPaths,
    );
  const cancelSession = async (task: Task, explanation: string) => {
    const id = "remote-" + task.id;
    try {
      await workspace.sessions.recordTask(
        id,
        taskInputText(task),
        explanation,
        true,
      );
    } finally {
      await workspace.sessions.setTaskState(id, "cancelled");
    }
  };
  const shutdown = new AbortController(),
    stopping = AbortSignal.any([stop, shutdown.signal]);
  const stopRepositories = () => { void workspace.repositories.close().catch(() => {}); };
  stopping.addEventListener("abort", stopRepositories, { once: true });
  if (stopping.aborted) stopRepositories();
  const running = new Map<
    string,
    {
      task: Task;
      promise: Promise<void>;
    }
  >();
  let connected = false;
  const waiting = new Map<string, { task: Task; lease: AttemptLease }>();
  let localTimer: ReturnType<typeof setInterval> | undefined;
  const operationalState = () =>
    stopping.aborted
      ? "stopping"
      : !workspace.settings.value.connection.enabled
        ? "standalone"
        : !connected
          ? "disconnected"
          : running.size
            ? "executing"
            : "idle";
  let status: Awaited<ReturnType<typeof statusServer>> | undefined,
    writing = Promise.resolve();
  const save = () => {
    state.updatedAt = new Date(now()).toISOString();
    state.queueCapacity = workspace.settings.value.board.orchestratorQueue;
    state.queuedTasks = [...waiting.values()].map(({ task }) => ({
      id: task.id,
      profile: task.profile,
    }));
    state.activeTasks = [...running.values()].map(({ task }) => ({
      id: task.id,
      attempt: task.attempt,
      profile: task.profile,
    }));
    const first = state.activeTasks[0];
    state.taskId = first?.id ?? null;
    state.attempt = first?.attempt ?? null;
    state.profile = first?.profile ?? null;
    const body = JSON.stringify(state, null, 2);
    writing = writing
      .catch(() => {})
      .then(() => atomicWrite(join(config.stateDir, "status.json"), body));
    return writing;
  };
  // The status file is an observability snapshot: a transient write failure (for example a
  // Windows scanner briefly locking it) is reported and retried on the next poll, never fatal.
  const publishStatus = () =>
    save().catch(() => {
      serviceEvent("worker", "state_write_error", "error");
    });
  const execute = async () => {
    await handle.writeFile(String(process.pid));
    await handle.sync();
    await handle.close();
    await executionProfiles.init();
    if (executionProfiles.pending && !(await readRegisteredIdentity(config.stateDir))) await executionProfiles.commit();
    applyProfileState();
    await journal.init();
    await workspace.init();
    status = await statusServer(
      () => ({ ...state, outbox: journal.metrics(now()) }),
      config.statusHost,
      config.statusPort,
      undefined,
      workspace,
    );
    serviceEvent("worker", "service_listening");
    // Keep the CLI's documented/discoverable ephemeral status endpoint available.
    console.error(
      JSON.stringify({
        event: "status_listening",
        address: status.address(),
        mode: adapter.mode,
        maxParallel: config.policy.maxParallel,
      }),
    );
    try {
      state.machineId = (
        await readBoundedFile(join(config.stateDir, "machine-id"), 128)
      ).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state.machineId = randomUUID();
      await atomicWrite(join(config.stateDir, "machine-id"), state.machineId);
    }
    const bound = status.address();
    if (bound && typeof bound !== "string") await dependencies.ready?.(bound);
    localTimer = setInterval(() => {
      void workspace.features?.tick();
      void workspace.featureTracking.sync();
      workspace.executor.wake();
      workspace.reviews.tick();
      void workspace.board.tick().catch(() => {
        serviceEvent("worker", "state_write_error", "error");
      });
    }, 250);
    while (!stopping.aborted) {
      try {
        const connection = workspace.settings.value.connection;
        if (!connection.enabled) {
          connected = false;
          state.state = "standalone";
          state.lastError = null;
          await publishStatus();
        } else {
          if (!session) {
            const initialize = async () => {
            const gateway =
              dependencies.gateway ??
              new HttpWorkerGateway(connection.url, connection.enrollmentToken);
            const identity = await loadOrRegisterIdentity(
              config.stateDir,
              connection.url,
              config.profiles,
              { ...config.policy, ...repositoryScope() },
              gateway,
              stopping,
              executionProfiles.pending?.configurationHash,
            );
            await journal.recover(
              identity.id,
              config.profiles,
              state,
              (before) => remoteGates(identity.url).recoverSnapshot(before),
            );
            session = {
              url: connection.url,
              identity,
              client: gateway.connect(identity),
            };
            state.workerId = identity.id;
            state.project = identity.project;
            };
            // A pending transition already blocks admissions; otherwise reserve registration too.
            if (executionProfiles.pending) await initialize();
            else await workspace.withRepositoryAdmission(initialize);
          }
          const { client, identity } = session!;
          const reconciliation = await gateReconciler.tick(
            client,
            identity,
            now(),
          );
          if (reconciliation.failed)
            serviceEvent("worker", "gate_resolution_pending", "warn");
          await journal.flush((snapshot) => client.publishSnapshot(snapshot));
          if (executionProfiles.pending) {
            await workspace.withIdleConfiguration(async () => {
              const pending = executionProfiles.pending!;
              if (!client.updateProfiles) throw new DomainError('unavailable', 'The orchestrator must support editable execution profiles before this saved change can be applied.');
              const acknowledgement = await client.updateProfiles({ ...pending, expectedConfigurationHash: executionProfiles.active.configurationHash });
              if (acknowledgement.configurationHash !== pending.configurationHash || JSON.stringify(acknowledgement.profiles) !== JSON.stringify(pending.profiles))
                throw new DomainError('conflict', 'The orchestrator acknowledged different execution profiles.');
              const updated = { ...identity, configHash: pending.configurationHash };
              // Persist identity first: a crash here is recoverable using the durable pending hash.
              await atomicWrite(join(config.stateDir, 'identity.json'), JSON.stringify(updated));
              session!.identity = updated;
              await executionProfiles.commit();
              applyProfileState();
              await save();
            });
          }
          const accept = async (task: Task) => {
            if (
              !task.lease ||
              running.has(task.lease) ||
              waiting.has(task.lease) ||
              (task.expiresAt ?? 0) <= now()
            )
              return;
            await workspace.rememberTask(task);
            const lease = new AttemptLease(task, client, state, now);
            try {
              await workspace.sessions.prepareTask(
                "remote-" + task.id,
                taskInputText(task),
              );
              await workspace.sessions.setTaskState(
                "remote-" + task.id,
                "queued",
              );
              await lease.start();
              waiting.set(task.lease, { task, lease });
            } catch (error) {
              await lease.close();
              // Acceptance failed before entering the waiting map; no later poll can reconcile this session.
              await cancelSession(
                task,
                "The remote assignment could not be accepted. No execution started; inspect worker status and orchestrator events.",
              );
              throw error;
            }
          };
          const board = workspace.settings.value.board;
          {
            await workspace.withRepositoryAdmission(async () => {
              try {
                const current = await client.currentAssignments();
                for (const [id, entry] of waiting)
                  if (
                    entry.lease.signal.aborted ||
                    !current.some((task) => task.lease === id)
                  ) {
                    await entry.lease.close();
                    waiting.delete(id);
                    await cancelSession(
                      entry.task,
                      "The assignment lease expired or was withdrawn before execution.",
                    );
                  }
                for (const task of current) await accept(task);
                const capacity =
                  config.policy.maxParallel + board.orchestratorQueue;
                for (
                  let n = 0;
                  n < capacity &&
                  !board.paused &&
                  !workspace.consumption.status().blocked &&
                  running.size + waiting.size < capacity &&
                  !stopping.aborted;
                  n++
                ) {
                  const scope = repositoryScope();
                  const task = await client.claim(
                    requestId,
                    board.orchestratorQueue,
                    scope.repositoryIds,
                    scope.legacyRepository,
                  );
                  requestId = randomUUID();
                  if (!task) break;
                  await accept(task);
                }
              } finally {
                // Publish accepted leases before releasing the assignment-change guard.
                await save();
              }
            });
            const pending = [...waiting.entries()].sort(
              ([, a], [, b]) =>
                (board.order === "priority"
                  ? b.task.priority - a.task.priority
                  : 0) || a.task.createdAt - b.task.createdAt,
            );
            for (const [id, entry] of pending) {
              if (
                running.size ||
                stopping.aborted ||
                workspace.settings.value.board.paused ||
                workspace.consumption.status().blocked ||
                workspace.executor.busy
              )
                break;
              const task = entry.task,
                sessionId = "remote-" + task.id;
              const release = await workspace.executor.acquire(
                sessionId,
                AbortSignal.any([stopping, entry.lease.signal]),
              );
              // Keep renewing while another task owns the shared worker permit.
              if (
                stopping.aborted ||
                entry.lease.signal.aborted ||
                workspace.settings.value.board.paused || workspace.consumption.status().blocked
              ) {
                release();
                continue;
              }
              try {
                await entry.lease.close();
                if (stopping.aborted || workspace.settings.value.board.paused || workspace.consumption.status().blocked) {
                  if (!stopping.aborted) {
                    const lease = new AttemptLease(task, client, state, now);
                    try {
                      await lease.start();
                      waiting.set(id, { task, lease });
                    } catch (error) {
                      await lease.close();
                      throw error;
                    }
                  }
                  release();
                  continue;
                }
              } catch (error) {
                release();
                throw error;
              }
              waiting.delete(id);
              if (entry.lease.signal.aborted) {
                release();
                await cancelSession(
                  task,
                  "The assignment lease expired before execution.",
                );
                continue;
              }
              const input = taskInputText(task);
              const promise = Promise.resolve()
                .then(async () => {
                  await workspace.sessions.setTaskState(sessionId, "running");
                  const gates = remoteGates(identity.url);
                  const terminal = await executeAttempt(task, stopping, {
                    gates,
                    client,
                    journal,
                    adapter,
                    identity,
                    profiles: config.profiles,
                    state,
                    saveState: save,
                    timeoutMs: config.timeoutMs,
                    now,
                  });
                  const failed = !["simulated", "change-set"].includes(
                    terminal.execution.outcome,
                  );
                  await workspace.sessions.recordTask(
                    sessionId,
                    input,
                    JSON.stringify(
                      {
                        execution: terminal.execution,
                        requestGate: terminal.requestGate ?? null,
                        review: terminal.review ?? null,
                        quality: terminal.quality,
                        provenance: terminal.provenance,
                      },
                      null,
                      2,
                    ),
                    failed,
                  );
                  await workspace.sessions.setTaskState(
                    sessionId,
                    terminal.execution.outcome === "interrupted"
                      ? "cancelled"
                      : failed
                        ? "failed"
                        : "completed",
                  );
                })
                .catch(async (error) => {
                  state.lastError = error.message;
                  serviceEvent("worker", "attempt_error", "error");
                  await workspace.sessions.recordTask(
                    sessionId,
                    input,
                    "The attempt was interrupted or could not finish acknowledgement. Inspect its snapshots and orchestrator events before retrying.",
                    true,
                  );
                  await workspace.sessions.setTaskState(
                    sessionId,
                    stopping.aborted ? "cancelled" : "failed",
                  );
                })
                .finally(async () => {
                  release();
                  running.delete(id);
                  state.state = operationalState();
                  await save();
                })
                .catch(() => {
                  serviceEvent("worker", "state_write_error", "error");
                });
              running.set(id, { task, promise });
            }
          }
          state.lastContact = new Date(now()).toISOString();
          if (!connected) serviceEvent("worker", "connection_restored");
          connected = true;
          state.state = operationalState();
          await publishStatus();
        }
      } catch (error) {
        if (error instanceof IdentityConfigurationError) throw error;
        if (connected) serviceEvent("worker", "connection_lost", "warn");
        connected = false;
        state.state = operationalState();
        state.lastError = (error as Error).message;
        await publishStatus();
      }
      try {
        await delay(config.pollMs + Math.random() * 250, undefined, {
          signal: stopping,
        });
      } catch {
        break;
      }
    }
  };
  await withCleanup(async () => {
    try { await execute(); }
    catch (error) { if (!stopping.aborted) throw error; }
  }, async () => {
    shutdown.abort();
    stopping.removeEventListener("abort", stopRepositories);
    state.state = "stopping";
    if (localTimer) clearInterval(localTimer);
    await settleCleanup(
      [closeWorkspace, () => drainHttpServer(status)],
      [...waiting.values()].map(entry => () => settleCleanup(
        () => entry.lease.close(),
        () => cancelSession(entry.task, "The worker stopped before this queued assignment executed."),
      )),
      [...running.values()].map(entry => () => entry.promise),
      () => closeEvidence().catch(error => {
        serviceEvent("worker", "state_write_error", "error");
        throw error;
      }),
      () => { state.state = "stopped"; return save(); },
    );
  });
}
