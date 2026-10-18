

                                                            

import { randomUUID } from "node:crypto";

import { DomainError } from "../../shared/errors.js";

import {                } from './local-task-contracts.js';
                                                                         

export function executeRequest(host                                                                     , id        ) {
    return host.trackContinuation(host.executeOwnedRequest(id));
  }

export async function executeOwnedRequest(host                                                                                                                                                                                                                                                                                    , id        ) {
    if (host.closed) throw new DomainError("unavailable", "Worker is stopping.");
    const request = host.sessions.requests.get(id);
    const retainedTask = host.tasks.find(task => task.sessionId === request.owner.sessionId);
    if (retainedTask) host.assertAcceptedSnapshots(retainedTask);
    if (request.owner.remote || request.input.kind !== "patch")
      throw new DomainError(
        "conflict",
        "This request belongs to another execution owner.",
      );
    if (request.execution?.inputRevision === request.inputRevision)
      return host.view();
    if (!host.sessions.requests.evaluate(id, "ready").passed) {
      host.sessions.notifyRequest(id);
      return host.view();
    }
    let admissionFailure                                ;
    let reserved = false;
    await host.change(async (tasks) => {
      const task = tasks.find(
        (item) => item.sessionId === request.owner.sessionId,
      );
      if (!task || task.requestId !== id)
        throw new DomainError(
          "not_found",
          "The owning file task is unavailable.",
        );
      if (host.running.has(task.id)) return;
      const current = host.sessions.requests.get(id);
      if (current.execution?.inputRevision === current.inputRevision) return;
      if (
        tasks.filter((item) => ["queued", "running"].includes(item.status)).length +
          host.sessions.chatActive + Number(host.admissionReserved) +
          host.continuationReservations + host.waitingPreparations >=
        host.settings.value.board.queueCapacity
      )
        throw new DomainError("conflict", "Local task queue is full.");
      const approved = host.gateInput(task).files;
      if (JSON.stringify(approved) !== JSON.stringify(current.input.files))
        throw new DomainError(
          "conflict",
          "Rework cannot replace the frozen approved file snapshots. Create a new file task for different paths.",
        );
      task.instruction = current.input.message;
      task.title = current.input.title;
      task.criteria = current.input.criteria === undefined ? undefined : structuredClone(current.input.criteria);
      if (current.inputRevision > 1) {
        const previous = host.sessions.interactions.view(task.sessionId);
        if (previous.pending)
          host.sessions.interactions.abandon(
            task.sessionId,
            previous.revision,
            "supersede-" + current.id + "-" + current.inputRevision,
            previous.pending.id,
          );
      }
      const accepted = host.sessions.interactions.accept({
        sessionId: task.sessionId,
        kind: "message",
        // Command replay is handled by the request journal; failed admissions
        // must not pin every later guarded execute to an undispatched turn.
        operationId: randomUUID(),
        input: task.instruction,
        context: host.context(task),
      });
      if (accepted.duplicate) return;
      task.currentTurnId = accepted.turn.id;
      delete task.runId;
      // Keep the queue slot visible until the serialized board write publishes it.
      host.continuationReservations++;
      reserved = true;
      try {
        await host.prepareTurn(task, accepted.turn);
      } catch (error) {
        host.sessions.interactions.fail(
          task.sessionId, accepted.turn.id, "failed", "admission_failed",
        );
        if (task.runId)
          await host.sessions.runs.finish(task.runId, "failed").catch(() => {
            host.evidencePersistenceError = true;
          });
        if (host.sessions.requests.get(id).execution?.turnId === accepted.turn.id)
          host.sessions.requests.failExecution(id, accepted.turn.id, "failed");
        Object.assign(task, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: "Admission did not finish. The accepted input remains saved; repair the provider and issue a fresh guarded execute.",
        });
        admissionFailure = { error };
        return;
      }
      Object.assign(task, {
        status: "queued",
        finishedAt: null,
        error: null,
        summary: null,
        patch: null,
        archived: false,
      });
    }).finally(() => {
      if (reserved) host.continuationReservations--;
    });
    if (admissionFailure) throw admissionFailure.error;
    return host.view();
  }

export function interact(host                                                              , body                    ) {
    return host.trackContinuation(host.continueTask(body));
  }

export async function continueTask(host                                                                                                                                                                                                                                                , body                    ) {
    if (host.closed)
      throw new DomainError("unavailable", "Worker is stopping.");
    let accepted 
                                                              
                   ,
      taskForFailure                       ;
    let reserved = false;
    try {
      await host.change(async (tasks) => {
        const task = tasks.find((item) => item.sessionId === body.sessionId);
        if (!task)
          throw new DomainError("not_found", "File-task session not found.");
        host.assertAcceptedSnapshots(task);
        const prior =
          body.turnId ??
          host.sessions.interactions.view(task.sessionId).pending?.turnId;
        const request = prior
          ? host.sessions.requests.forTurn(task.sessionId, prior)
          : task.requestId
            ? host.sessions.requests.get(task.requestId)
            : undefined;
        if (
          !host.sessions.interactions.operation(
            task.sessionId,
            body.operationId,
          ) &&
          request &&
          !host.sessions.requests.evaluate(request.id, "ready").passed
        ) {
          host.sessions.notifyRequest(request.id);
          throw new DomainError(
            "conflict",
            "Readiness is held. Use guarded request rework controls before answering or resuming.",
          );
        }
        if (
          request &&
          request.inputRevision > 1 &&
          !request.execution &&
          !host.sessions.interactions.operation(
            task.sessionId,
            body.operationId,
          )
        )
          throw new DomainError(
            "conflict",
            "Request input changed. Execute its accepted revision before continuing an older interaction.",
          );
        if (request) task.requestId = request.id;
        accepted = host.sessions.interactions.accept({
          sessionId: task.sessionId,
          kind: body.action,
          operationId: body.operationId,
          expectedRevision: body.expectedRevision,
          pendingId: body.pendingId,
          priorTurnId: body.turnId,
          input:
            body.action === "answer"
              ? (body.answer ?? "")
              : (body.message ??
                "Resume the saved approved-file task context."),
          context: host.context(task),
        });
        if (accepted.duplicate) return;
        taskForFailure = task;
        if (
          host.running.has(task.id) ||
          tasks.filter((item) => ["queued", "running"].includes(item.status))
            .length +
            host.sessions.chatActive + Number(host.admissionReserved) +
            host.continuationReservations >=
            host.settings.value.board.queueCapacity
        )
          throw new DomainError(
            "conflict",
            "The answer is saved, but the worker queue is full. Resume when capacity is available.",
          );
        host.continuationReservations++;
        reserved = true;
        await host.prepareTurn(task, accepted.turn);
        Object.assign(task, {
          status: "queued",
          finishedAt: null,
          error: null,
          summary: null,
          patch: null,
          archived: false,
        });
      });
    } catch (error) {
      if (accepted && !accepted.duplicate && taskForFailure) {
        host.sessions.interactions.fail(
          taskForFailure.sessionId,
          accepted.turn.id,
          "failed",
          "admission_failed",
        );
        const failedTurn = host.sessions.interactions.turn(
          taskForFailure.sessionId,
          accepted.turn.id,
        );
        if (failedTurn.runId)
          await host.sessions.runs
            .finish(failedTurn.runId, "failed")
            .catch(() => {
              host.evidencePersistenceError = true;
            });
        // Admission can fail after the answer is durable but before the board publishes it.
        // Project that exact accepted turn without attributing failure to an older run.
        await host.change(async (tasks) => {
          const task = tasks.find(
            (item) => item.sessionId === taskForFailure .sessionId,
          );
          if (
            !task ||
            host.sessions.interactions.view(task.sessionId).latestTurn?.id !==
              failedTurn.id
          )
            return;
          Object.assign(task, {
            currentTurnId: failedTurn.id,
            runId: failedTurn.runId ?? undefined,
            status: "failed",
            finishedAt: failedTurn.finishedAt,
            error:
              "Accepted input is saved. Resume explicitly when worker capacity is available.",
            summary: null,
            patch: null,
          });
        }).catch(() => {
          host.persistenceError = true;
        });
      }
      throw error;
    } finally {
      if (reserved) host.continuationReservations--;
    }
    return host.sessions.interactions.view(body.sessionId);
  }
