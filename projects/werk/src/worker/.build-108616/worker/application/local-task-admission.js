

import { validateApprovedPaths } from './approved-paths.js';

import { definitionConnection,                         } from "./definitions.js";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { object, text } from "../../shared/contracts.js";
import { DomainError } from "../../shared/errors.js";

import { BACKGROUND_ADMISSION_TIMEOUT_MS, freezeSubmission, submissionContextHash,                                                                     } from './local-task-contracts.js';
                                                                         

export async function create(host                                                                                                                                                , input         , submission                      ) {
    const frozen = submission === undefined ? undefined : freezeSubmission(submission);
    if (((input                                  )?.background === true || frozen && host.preparations.some(item => item.id === frozen.id)) && (!frozen || !host.tasks.some(task => task.id === frozen.id)))
      return host.createInBackground(input, frozen);
    // Serialize admission so duplicate durable IDs never prepare a second worktree.
    return host.admitting.run(async () => {
      try {
        return await host.createTask(input, frozen);
      } finally {
        host.admissionReserved = false; host.admissionTaskId = undefined;
      }
    });
  }

export function forgetPreparation(host                                                              , preparation                      ) {
    const index = host.preparations.indexOf(preparation);
    if (index >= 0) host.preparations.splice(index, 1);
    host.preparationOwners.delete(preparation.id);
  }

export function createInBackground(host                                                                                                                                                                                                                                                                          , input         , submission                      ) {
    if (host.closed) throw new DomainError("unavailable", "Worker is stopping");
    const retained = submission && host.preparations.find(item => item.id === submission.id);
    const retainedOwner = retained ? host.preparationOwners.get(retained.id) : undefined;
    if (retained) {
      const accepted = retainedOwner?.submission;
      if (accepted?.hash !== submission.hash || submissionContextHash(accepted) !== submissionContextHash(submission) || accepted?.feature?.key !== submission.feature?.key)
        throw new DomainError('conflict', 'Task ID belongs to different input.');
      if (retained.state === 'preparing') return { ...host.view(), preparationId: retained.id };
      // A new explicit create command retries a failed preparation. Status polling never calls this method.
      // Keep the failed receipt until replacement admission validates and reserves capacity.
    }
    const snapshot = structuredClone(input);
    const { title, selector, definition } = host.admissionInput(snapshot, submission, retainedOwner?.definition);
    // A queued request and its explicit retries retain the exact accepted agent instructions.
    const frozenDefinition = definition ? structuredClone(definition) : null;
    host.assertAdmissionCapacity(host.tasks, host.admissionOccupancy);
    if (retained) host.forgetPreparation(retained);
    const preparation                       = {
      id: submission?.id ?? randomUUID(), title, repository: selector, state: "preparing", phase: "waiting",
      error: null, createdAt: new Date().toISOString(), finishedAt: null,
    };
    const failed = host.preparations.filter(item => item.state === 'failed');
    if (failed.length >= 20) host.forgetPreparation(failed[0] );
    const controller = new AbortController();
    host.preparationOwners.set(preparation.id, { submission, definition: frozenDefinition, controller });
    host.preparations.push(preparation);
    void host.admitting.run(async () => {
      try {
        controller.signal.throwIfAborted();
        preparation.phase = "worktree";
        await host.createTask(snapshot, submission, { id: preparation.id, budgetMs: BACKGROUND_ADMISSION_TIMEOUT_MS, preparation, signal: controller.signal, definition: frozenDefinition });
        // A cancellation that raced the durable write still cancels before tick can start this task.
        const task = host.tasks.find(item => item.id === preparation.id);
        if (controller.signal.aborted && task?.status === 'queued') await host.action({ id: task.id, action: 'cancel' });
        host.forgetPreparation(preparation);
      } catch (error) {
        Object.assign(preparation, {
          state: "failed", finishedAt: new Date().toISOString(),
          error: controller.signal.aborted ? 'Task preparation was cancelled. Retry the same request to try again.' : error instanceof DomainError ? error.message : "The task could not be admitted. Check the repository status and worker log, then retry the same request.",
        });
      } finally {
        host.admissionReserved = false; host.admissionTaskId = undefined;
      }
    });
    return { ...host.view(), preparationId: preparation.id };
  }

export function assertAdmissionCapacity(host                                                                                                      , tasks             , reserved = 0) {
    if (tasks.length + host.waitingPreparations + reserved >= 100)
      throw new DomainError(
        "conflict",
        "Taskboard holds 100 tasks. Delete an old task first.",
      );
    if (
      tasks.filter((item) => ["queued", "running"].includes(item.status)).length +
        host.sessions.chatActive + host.continuationReservations + host.waitingPreparations + reserved >=
      host.settings.value.board.queueCapacity
    )
      throw new DomainError("conflict", "Local task queue is full.");
  }

export function admissionInput(host                                                                , input         , submission                      , frozenDefinition                            ) {
    const body = object(input, "Local task", [
      "title",
      "instruction",
      "repository",
      "paths",
      "priority",
      "provider",
      "definitionId",
      "definitionRef",
      "agent",
      "useInstructionsOnly",
      "background",
    ]);
    if (body.background !== undefined && typeof body.background !== "boolean")
      throw new DomainError("invalid_input", "background must be true or false.");
    const title = text(body.title, "Title", 200),
      instruction = text(body.instruction, "Instruction", 8000);
    const definition = frozenDefinition === undefined ? host.sessions.definitions.select(body) : frozenDefinition ?? undefined;
    const provider = definitionConnection(
      host.settings.provider(
        body.provider === undefined
          ? host.sessions.current.provider
          : String(body.provider),
      ),
      definition,
    );
    const selector = text(body.repository, "Repository", 4096);
    const assignments = host.settings.value.repositories.items;
    const assignment = assignments.find(
      (item) =>
        item.id === selector ||
        (isAbsolute(selector) && resolve(item.path) === resolve(selector)),
    );
    if (assignments.length && !assignment)
      throw new DomainError(
        "invalid_input",
        "Choose a repository assigned to this worker.",
      );
    if (submission?.repositoryId !== undefined && assignment?.id !== submission.repositoryId)
      throw new DomainError("conflict", "The task repository does not match its reserved assignment.");
    if (submission?.baseCommit && !host.workspaces)
      throw new DomainError("unavailable", "Pinned task admission requires the repository worktree service.");
    const repositoryPath = assignment?.path ?? selector;
    if (!isAbsolute(repositoryPath)) throw new DomainError("invalid_input", "Repository must be an absolute project folder or assigned repository.");
    const allowedPaths = validateApprovedPaths(body.paths);
    if (
      body.priority !== undefined &&
      body.priority !== 1 &&
      body.priority !== 2
    )
      throw new DomainError("invalid_input", "Priority must be 1 or 2");
    if (assignment && !host.workspaces)
      throw new DomainError(
        "unavailable",
        "The assigned repository worktree service is unavailable.",
      );
    return { body, title, instruction, definition, provider, selector, assignment, repositoryPath, allowedPaths };
  }
