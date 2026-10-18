

                                                                                   
import { projectLocalTaskSummary, projectLocalTaskDetail } from './local-task-view.js';

import {                         } from "./definitions.js";

import { DomainError } from "../../shared/errors.js";

import {                                           } from './local-task-contracts.js';
                                                                         

export function active(host                                                                                                             ) {
    return (
      host.admissionOccupancy + host.continuationReservations + host.waitingPreparations +
      host.tasks.filter((task) =>
        ["queued", "running"].includes(task.status),
      ).length
    );
  }

export function admissionOccupancy(host                                                                           ) {
    return Number(host.admissionReserved && !host.tasks.some(task => task.id === host.admissionTaskId && ['queued', 'running'].includes(task.status)));
  }

export function preparation(host                                        , id        )                                   {
    const preparation = host.preparations.find(item => item.id === id);
    return preparation ? { ...preparation } : undefined;
  }

export function preparationDefinition(host                                             , id        )                                 {
    const definition = host.preparationOwners.get(id)?.definition;
    return definition ? structuredClone(definition) : undefined;
  }

export function view(host                                                                                                                              )                     {
    return {
      settings: { ...host.settings.value.board },
      tasks: host.tasks.map(task => projectLocalTaskSummary(
        task,
        host.sessions.interactions.view(task.sessionId),
        task.requestId ? host.sessions.requests.get(task.requestId) : undefined,
      )),
      preparations: host.preparations.map((item) => ({ ...item })),
      persistenceError: host.persistenceError || host.evidencePersistenceError,
      running: host.tasks.filter((task) => task.status === "running").length,
    };
  }

export function waitingPreparations(host                                        ) {
    return host.preparations.filter((item) => item.state === "preparing" && item.phase === "waiting").length;
  }

export function detail(host                                           , id        )                      {
    const task = host.executionDetail(id);
    return projectLocalTaskDetail(task, task.interaction);
  }

export function executionDetail(host                                              , id        ) {
    const task = host.tasks.find((item) => item.id === id);
    if (!task) throw new DomainError("not_found", "Task not found");
    return {
      ...structuredClone(task),
      interaction: host.sessions.interactions.view(task.sessionId),
    };
  }

export async function persist(host                                                        , tasks             ) {
    const body = JSON.stringify(tasks);
    if (Buffer.byteLength(body) > 16777216)
      throw new DomainError(
        "conflict",
        "Taskboard storage is full. Delete old tasks to free space.",
      );
    await host.storage.write(body);
    host.persistenceError = false;
  }

export function change(host                                                                      , operation                                              ) {
    return host.writing.run(async () => {
      const next = structuredClone(host.tasks);
      await operation(next);
      const changed = next.filter(
        (task) =>
          host.tasks.find((item) => item.id === task.id)?.status !==
          task.status,
      );
      await host.persist(next);
      for (const task of host.tasks)
        if (!next.some((item) => item.id === task.id))
          host.sessions.protectTask(task.sessionId, false);
      host.tasks = next;
      for (const task of changed)
        await host.sessions.setTaskState(
          task.sessionId,
          task.status === "review" ? "completed" : task.status,
        );
    });
  }

export function trackContinuation   (host                                         , operation            )             {
    host.continuations.add(operation);
    return operation.finally(() => { host.continuations.delete(operation); });
  }

export async function close(host                                                                                                                  ) {
    host.closed = true;
    host.workspaceController.abort();
    for (const running of host.running.values()) running.controller.abort();
    await Promise.allSettled(
      [host.admitting.drain(), ...host.continuations, ...[...host.running.values()].map((item) => item.promise)],
    );
    await host.writing.drain();
  }
