import type { ModelSelection } from './model-selection.js';
import { loadTaskProjectContext } from './local-task-preparation.js';
import { interactionFeatureRequest } from './feature-request-reference.js';

import { assertFolderApprovals, freezeDevelopmentScope } from './development.js';

import { type DefinitionSnapshot } from "./definitions.js";
import { randomUUID } from "node:crypto";

import { DomainError } from "../../shared/errors.js";

import { ADMISSION_TIMEOUT_MS, submissionContextHash, type LocalTask, type LocalTaskWorkspaces, type LocalTaskPreparation, type LocalTaskSubmission } from './local-task-contracts.js';
import type { LocalTaskRuntime } from './local-task-runtime-contract.js';

export async function createTask(host: Pick<LocalTaskRuntime, "model" | "closed" | "tasks" | "view" | "admissionInput" | "assertAdmissionCapacity" | "admissionReserved" | "admissionTaskId" | "workspaceController" | "workspaces" | "files" | "development" | "settings" | "change" | "sessions" | "input" | "ensureRequest" | "context" | "prepareTurn" | "persistenceError">, input: unknown, submission?: LocalTaskSubmission, options: { id?: string; budgetMs?: number; preparation?: LocalTaskPreparation; signal?: AbortSignal; definition?: DefinitionSnapshot | null; selection?: ModelSelection } = {}) {
    if (host.closed) throw new DomainError("unavailable", "Worker is stopping");
    if (submission) {
      const existing = host.tasks.find((task) => task.id === submission.id);
      if (existing) {
        if (existing.submissionHash !== submission.hash ||
            existing.submissionContextHash !== submissionContextHash(submission))
          throw new DomainError(
            "conflict",
            "Task ID belongs to different input.",
          );
        if (submission.feature && existing.feature && submission.feature.key !== existing.feature.key)
          throw new DomainError('conflict', 'Task ID belongs to another feature request.');
        return host.view();
      }
    }
    const { body, title, instruction, definition, provider, selection, selector, assignment, repositoryPath, allowedPaths } = host.admissionInput(input, submission, options.definition, options.selection);
    // Reserve capacity before preparing a durable worktree. Chat admission reads
    // board.active, so a concurrent chat cannot consume this task's queue slot.
    // Refuse folder approvals before preparing a worktree when this worker cannot run an implementation.
    assertFolderApprovals(allowedPaths, host.settings.toolPolicy(), host.development ? undefined : false);
    host.assertAdmissionCapacity(host.tasks);
    host.admissionReserved = true;
    const id = submission?.id ?? options.id ?? randomUUID();
    host.admissionTaskId = id;
    // Bind interrupted preparation to the exact trusted command and frozen policy.
    // Legacy tasks keep their original key; the persisted key also verifies tool access.
    const worktreeKey = submission
      ? `${id}-${submission.hash}-${submissionContextHash(submission) ?? "default"}`
      : id;
    // One deadline covers repository queueing, fetch, checkout and the tool
    // workspace verification below; each phase used to get its own 30 s budget.
    const budgetMs = options.budgetMs ?? ADMISSION_TIMEOUT_MS, deadline = AbortSignal.timeout(budgetMs);
    const admission = AbortSignal.any([host.workspaceController.signal, deadline, ...(options.signal ? [options.signal] : [])]);
    const timedOut = (error: unknown) => {
      if (!host.workspaceController.signal.aborted && deadline.aborted) return new DomainError("unavailable", `Task worktree preparation did not finish within ${budgetMs / 1000} seconds. Check the repository status, then create the task again.`);
      return error;
    };
    let prepared: Awaited<ReturnType<LocalTaskWorkspaces["prepareWorktree"]>>;
    try {
      prepared = host.workspaces
        ? await host.workspaces.prepareWorktree(
            assignment?.id ?? selector,
            worktreeKey,
            admission,
            submission?.baseCommit,
          )
        : { repository: repositoryPath, path: repositoryPath };
    } catch (error) {
      throw timedOut(error);
    }
    admission.throwIfAborted();
    if (options.preparation) options.preparation.phase = "admission";
    if (
      assignment &&
      (prepared.repositoryId !== assignment.id || !prepared.baseCommit)
    )
      throw new DomainError(
        "conflict",
        "Assigned repository tasks require a committed Git worktree.",
      );
    if (submission?.baseCommit && prepared.baseCommit !== submission.baseCommit)
      throw new DomainError("conflict", "The prepared task worktree does not match its reserved source commit.");
    if (prepared.reused && !submission)
      throw new DomainError(
        "conflict",
        "This task worktree already exists. Inspect the retained task before submitting again.",
      );
    const interruptedWorktree = prepared.reused && prepared.pristine !== true;
    // Shared intake publishes the candidate through Git, so its implementation scope freezes the publisher's bounds.
    const implementation = !interruptedWorktree && host.development ? freezeDevelopmentScope(prepared.baseCommit, allowedPaths, host.settings.toolPolicy(), { sharedPublication: submission?.feature?.source === 'shared_git' }) : undefined;
    if (!interruptedWorktree) assertFolderApprovals(allowedPaths, host.settings.toolPolicy(), !!implementation);
    // Never turn modified or unverifiable retained contents into a fresh approval.
    // A durable failed receipt lets the operator leave an otherwise endless retry.
    const { repository, path: snapshotRoot, files } = interruptedWorktree
      ? { repository: prepared.repository, path: prepared.path, files: [] }
      : await host.files.snapshot(prepared, allowedPaths);
    admission.throwIfAborted();
    if (host.closed) throw new DomainError("unavailable", "Worker is stopping");
    const task: LocalTask = {
      selection: structuredClone(selection),
      ...(submission?.selection ? { selectionReserved: true } : {}),
      ...(submission ? { submissionHash: submission.hash, submissionContextHash: submissionContextHash(submission) } : {}),
      ...(submission?.definitionPrompts ? { definitionPrompts: structuredClone(submission.definitionPrompts) } : {}),
      ...(submission?.policy ? { gatePolicy: structuredClone(submission.policy) } : {}),
      ...(submission?.criteria === undefined ? {} : { criteria: structuredClone(submission.criteria) }),
      ...(definition ? { definition } : {}),
      ...(interruptedWorktree ? { admissionFailure: { paths: [...allowedPaths] } } : {}),
      id,
      feature: submission?.feature ?? interactionFeatureRequest(id),
      title,
      instruction,
      sessionId: "local-" + id,
      provider: provider.id,
      model: provider.model,
      repository,
      ...(prepared.baseCommit
        ? {
            repositoryId: prepared.repositoryId,
            worktree: snapshotRoot,
            worktreeKey,
            ...(interruptedWorktree ? {} : { worktreeIdentity: await host.files.identity(snapshotRoot) }),
            baseCommit: prepared.baseCommit,
          }
        : {}),
      files,
      ...(!interruptedWorktree && host.development ? { implementation } : {}),
      status: interruptedWorktree ? "failed" : "queued",
      priority: Number(body.priority ?? 1),
      createdAt: new Date().toISOString(),
      finishedAt: interruptedWorktree ? new Date().toISOString() : null,
      error: interruptedWorktree
        ? "Admission was interrupted and the retained worktree has changed or cannot be proven unchanged. No file snapshots were accepted. Inspect the preserved worktree, then create a new request to approve current repository files. This request cannot be resumed."
        : null,
      summary: null,
      patch: null,
      archived: false,
    };
    try {
      if (!task.admissionFailure) await loadTaskProjectContext(host, task, admission);
      await host.change(async (tasks) => {
        // Check within the serialized write as concurrent submissions may pass the initial fast path.
        const existing = tasks.find((item) => item.id === id);
        if (existing) {
          if (existing.submissionHash !== submission?.hash ||
              existing.submissionContextHash !== submissionContextHash(submission))
            throw new DomainError(
              "conflict",
              "Task ID belongs to different input.",
            );
          return;
        }
        host.assertAdmissionCapacity(tasks);
        await host.sessions.ensureTask(
          task.sessionId,
          "local",
          task.title,
          task.provider,
          task.submissionHash,
          task.definition,
          task.feature,
          task.selection,
        );
        if (task.admissionFailure) await host.sessions.blockContinuation(task.sessionId, task.error ?? 'This interrupted request has no accepted file snapshots. Inspect its retained worktree and create a new request.');
        host.sessions.protectTask(task.sessionId, true);
        await host.sessions.prepareTask(task.sessionId, host.input(task));
        if (task.admissionFailure) {
          tasks.push(task);
          return;
        }
        const request = host.ensureRequest(task);
        if (!host.sessions.requests.evaluate(request.id, "ready").passed) {
          task.status = "needs_rework";
          task.error =
            "Readiness checks did not pass. Inspect open questions, issues and gaps before guarded rework.";
          tasks.push(task);
          return;
        }
        const accepted = host.sessions.interactions.accept({
          sessionId: task.sessionId,
          kind: "message",
          operationId: task.id,
          input: task.instruction,
          context: host.context(task),
        });
        task.currentTurnId = accepted.turn.id;
        if (accepted.duplicate) {
          task.status = "failed";
          task.error =
            "A prior admission was interrupted. Resume explicitly from the retained context.";
          task.finishedAt = new Date().toISOString();
        } else {
          host.sessions.requests.bindTurn(
            request.id,
            accepted.turn.id,
            request.inputRevision,
          );
          try {
            await host.prepareTurn(task, accepted.turn, admission);
          } catch (error) {
            task.status = "failed";
            task.error =
              "Admission did not finish. Inspect the saved context and resume explicitly after configuring the provider.";
            task.finishedAt = new Date().toISOString();
            host.sessions.interactions.fail(
              task.sessionId,
              accepted.turn.id,
              "failed",
              "admission_failed",
            );
            if (task.runId) {
              await host.sessions.runs.finish(task.runId, "failed");
              host.sessions.requests.failExecution(
                request.id,
                accepted.turn.id,
                "failed",
              );
            }
          }
        }
        tasks.push(task);
      });
    } catch (error) {
      if (!host.tasks.some((item) => item.id === id)) {
        if (task.currentTurnId)
          host.sessions.interactions.fail(
            task.sessionId,
            task.currentTurnId,
            "failed",
            "admission_failed",
          );
        if (task.runId)
          await host.sessions.runs.finish(task.runId, "failed").catch(() => {
            host.persistenceError = true;
          });
        host.sessions.protectTask(task.sessionId, false);
        await host.sessions
          .setTaskState(task.sessionId, "failed")
          .catch(() => {});
      }
      throw error;
    }
    if (task.requestId) host.sessions.notifyRequest(task.requestId);
    return host.view();
  }
