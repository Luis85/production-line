

import { randomUUID } from "node:crypto";

import { object } from "../../shared/contracts.js";
import { DomainError } from "../../shared/errors.js";

import type { LocalTaskRuntime } from './local-task-runtime-contract.js';

export async function action(host: Pick<LocalTaskRuntime, "preparations" | "tasks" | "preparationOwners" | "view" | "forgetPreparation" | "executionDetail" | "assertAcceptedSnapshots" | "running" | "sessions" | "context" | "interact" | "change" | "input" | "removeTaskWorktree" | "executeRequest">, input: unknown, expectedInteractionRevision?: number) {
    const body = object(input, "Task action", ["id", "action", "priority", "removeWorktree", "discardChanges"]);
    const id = String(body.id);
    for (const flag of ["removeWorktree", "discardChanges"] as const)
      if (body[flag] !== undefined && (body.action !== "delete" || typeof body[flag] !== "boolean"))
        throw new DomainError("invalid_input", `${flag} is a true/false option of the delete action.`);
    const preparation = host.preparations.find((item) => item.id === id);
    if (preparation && !host.tasks.some((task) => task.id === id)) {
      if (body.action === 'cancel') {
        host.preparationOwners.get(id)?.controller.abort();
        if (preparation.phase === 'waiting') Object.assign(preparation, { state: 'failed', finishedAt: new Date().toISOString(), error: 'Task preparation was cancelled. Retry the same request to try again.' });
        return host.view();
      }
      if (body.action !== "delete")
        throw new DomainError("conflict", "This task is still being admitted. Delete a failed preparation or wait for the task.");
      if (preparation.state === "preparing")
        throw new DomainError("conflict", "The task worktree is still being prepared. Wait for it to finish or fail.");
      host.forgetPreparation(preparation);
      return host.view();
    }
    const ownedTask = host.tasks.find(task => task.id === id);
    const ownedRequest = ownedTask?.requestId ? host.sessions.requests.get(ownedTask.requestId) : undefined;
    if (ownedTask && ownedRequest?.delivery && ['retry', 'cancel'].includes(String(body.action))) {
      if (expectedInteractionRevision !== undefined) {
        const interaction = host.sessions.interactions.view(ownedTask.sessionId);
        if (interaction.revision !== expectedInteractionRevision || interaction.phase !== 'cancelled') return host.view();
      }
      const run = ownedRequest.delivery;
      const action = body.action === 'cancel' ? 'cancel' : run.status === 'interrupted' || run.status === 'paused' ? 'resume' : 'retry';
      if (!(action === 'cancel' && run.control?.action === 'cancel')) host.sessions.requests.command({ action, requestId: ownedRequest.id, expectedRevision: ownedRequest.revision, operationId: 'task-' + randomUUID(), deliveryRunId: run.id, inputRevision: ownedRequest.inputRevision });
      if (action === 'cancel') {
        host.running.get(id)?.controller.abort();
        if (host.sessions.requests.get(ownedRequest.id).delivery?.status === 'cancelled') await host.change(tasks => { const task = tasks.find(item => item.id === id)!; task.status = 'cancelled'; task.finishedAt = new Date().toISOString(); task.error = 'Delivery cancelled by the operator.'; });
      } else await host.executeRequest(ownedRequest.id);
      return host.view();
    }
    if (ownedRequest?.delivery && ['archive', 'delete'].includes(String(body.action)) && ['running', 'pause_pending', 'paused', 'interrupting', 'outcome_unknown', 'reconciling'].includes(ownedRequest.delivery.status)) throw new DomainError('conflict', 'Stop and reconcile the delivery before archiving or deleting its retained workspace.');
    let worktree: { outcome: "removed" | "kept" | "not_applicable"; reason?: string } | undefined;
    if (body.action === "retry") {
      const task = host.executionDetail(id);
      host.assertAcceptedSnapshots(task);
      if (
        !["failed", "cancelled"].includes(task.status) ||
        host.running.has(id)
      )
        throw new DomainError(
          "conflict",
          "Only stopped or failed tasks can be retried. Answer pending questions through the interaction controls.",
        );
      let view = host.sessions.interactions.view(task.sessionId);
      if (!view.latestTurn) {
        const legacy = host.sessions.interactions.accept({
          sessionId: task.sessionId,
          kind: "message",
          operationId: task.id,
          input: task.instruction,
          context: host.context(task),
        });
        host.sessions.interactions.fail(
          task.sessionId,
          legacy.turn.id,
          "interrupted",
          "legacy_context",
        );
        view = host.sessions.interactions.view(task.sessionId);
      }
      await host.interact({
        action: "resume",
        sessionId: task.sessionId,
        operationId: randomUUID(),
        expectedRevision: view.revision,
        turnId: view.latestTurn!.id,
      });
      return host.view();
    }
    if (body.action === "cancel" && expectedInteractionRevision === undefined)
      host.running.get(id)?.controller.abort();
    await host.change(async (tasks) => {
      const task = tasks.find((item) => item.id === id);
      if (!task) throw new DomainError("not_found", "Task not found");
      if (expectedInteractionRevision !== undefined) {
        const interaction = host.sessions.interactions.view(task.sessionId);
        if (
          interaction.revision !== expectedInteractionRevision ||
          interaction.phase !== "cancelled"
        )
          return;
      }
      if (body.action === "cancel") {
        if (task.status === "queued") {
          task.status = "cancelled";
          task.finishedAt = new Date().toISOString();
          await host.sessions.recordTask(
            task.sessionId,
            host.input(task),
            "Task cancelled before execution.",
            true,
          );
          if (task.currentTurnId)
            host.sessions.interactions.fail(
              task.sessionId,
              task.currentTurnId,
              "cancelled",
              "operator_cancelled",
            );
          if (task.runId)
            await host.sessions.runs.finish(task.runId, "cancelled");
          if (task.requestId && task.currentTurnId)
            host.sessions.requests.failExecution(
              task.requestId,
              task.currentTurnId,
              "cancelled",
            );
        } else if (
          ["waiting_input", "escalated", "needs_rework"].includes(task.status)
        ) {
          if (
            host.sessions.interactions.view(task.sessionId).phase !==
            "cancelled"
          )
            host.sessions.interactions.abandon(task.sessionId);
          task.status = "cancelled";
          task.finishedAt = new Date().toISOString();
          task.error = "Task cancelled while waiting for operator input.";
        } else if (task.status !== "running")
          throw new DomainError("conflict", "Task is no longer active");
      }
      if (body.action === "cancel") {
        if (task.requestId) {
          const request = host.sessions.requests.get(task.requestId);
          if (
            request.phase !== "cancelled" &&
            request.execution?.status !== "running"
          )
            host.sessions.requests.command({
              action: "cancel",
              requestId: request.id,
              expectedRevision: request.revision,
              operationId: "cancel-" + randomUUID(),
            });
        }
      } else if (body.action === "priority") {
        if (task.status !== "queued" || (!Number.isInteger(body.priority) || ![0, 1, 2, 3].includes(Number(body.priority))))
          throw new DomainError(
            "invalid_input",
            "Only queued tasks can change priority: 0 low, 1 normal, 2 high, 3 urgent",
          );
        task.priority = Number(body.priority);
      } else if (
        body.action === "archive" ||
        body.action === "restore" ||
        body.action === "delete"
      ) {
        if (
          body.action !== "restore" &&
          host.sessions.requests.hasActiveReview(task.sessionId)
        )
          throw new DomainError(
            "conflict",
            "Cancel and drain the request reviewer before archiving or deleting its file task.",
          );
        if (
          ["running", "queued", "waiting_input", "escalated"].includes(
            task.status,
          )
        )
          throw new DomainError(
            "conflict",
            "Stop the task or resolve its pending input first",
          );
        if (body.action === "archive" || body.action === "restore")
          task.archived = body.action === "archive";
        else {
          // Serialized with every task change, so a retry cannot start while its worktree is removed.
          worktree = await host.removeTaskWorktree(task, body.removeWorktree as boolean | undefined, body.discardChanges === true);
          tasks.splice(tasks.indexOf(task), 1);
        }
      } else throw new DomainError("invalid_input", "Unknown task action");
    });
    return worktree ? { ...host.view(), worktree } : host.view();
  }
