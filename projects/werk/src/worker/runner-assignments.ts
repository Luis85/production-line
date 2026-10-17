import { RemoteRequestGates } from "./application/remote-request-gates.js";
import { AttemptLease } from "./application/lease.js";
import { WorkerWorkspace } from "./status/workspace.js";
import { serviceEvent, stateWriteError } from "../shared/http/observability.js";
import { randomUUID } from "node:crypto";
import { type Task, type Adapter } from "../shared/contracts.js";
import { type Status } from "./status/server.js";
import { SnapshotJournal } from "./infrastructure/journal/snapshots.js";
import { executeAttempt } from "./application/execute-attempt.js";
import type { WorkerConfig } from './runner.js';
import type { WorkerClient, WorkerIdentity } from './application/ports.js';
export interface AssignmentContext {
  config: WorkerConfig;
  workspace: WorkerWorkspace;
  state: Status;
  journal: SnapshotJournal;
  adapter: Adapter;
  now: () => number;
  stopping: AbortSignal;
  running: Map<string, { task: Task; promise: Promise<void> }>;
  waiting: Map<string, { task: Task; lease: AttemptLease }>;
  repositoryScope: () => { repositoryIds: string[]; legacyRepository: boolean };
  claimIdentity: { current: string };
  cancelSession: (task: Task, explanation: string) => Promise<void>;
  remoteGates: (origin: string) => RemoteRequestGates;
  operationalState: () => string;
  save: () => Promise<void>;
}

export const taskInputText = (task: Task) =>
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

/** Reconcile remote leases, then dispatch accepted work through the shared worker permit. */
export async function pollRemoteAssignments(context: AssignmentContext, client: WorkerClient, identity: WorkerIdentity) {
  const { config, workspace, state, journal, adapter, now, stopping, running, waiting, repositoryScope, claimIdentity, cancelSession, remoteGates, operationalState, save } = context;
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
            claimIdentity.current,
            board.orchestratorQueue,
            scope.repositoryIds,
            scope.legacyRepository,
          );
          claimIdentity.current = randomUUID();
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
        .catch((error) => {
          stateWriteError("worker", "task_state", error);
        });
      running.set(id, { task, promise });
    }
  }
}
