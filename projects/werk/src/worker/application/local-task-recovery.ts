import { localTaskSelection, validateTaskSelection } from './local-task-selection.js';
import { validateFeatureDefinitionPrompts } from './feature-workflow.js';
import { interactionFeatureRequest } from './feature-request-reference.js';
import { isPreparedLocalTask } from './queued-task-recovery.js';
import { DomainError } from '../../shared/errors.js';
import { validateFeatureRequestReference } from './feature-request-reference.js';

import { validateDevelopmentState } from './development.js';

import { gateDigest } from "./request-gates.js";


import { submissionContextHash, type LocalTask, type TaskFile } from './local-task-contracts.js';
import type { LocalTaskRuntime } from './local-task-runtime-contract.js';

export async function init(host: Pick<LocalTaskRuntime, "storage" | "tasks" | "recoverTask" | "sessions" | "persist">) {
    const saved = await host.storage.read();
    if (saved !== undefined) {
      const value = JSON.parse(saved);
      if (
        !Array.isArray(value) ||
        value.length > 100 ||
        value.some(
          (task) =>
            !task ||
            !/^[a-z0-9-]+$/.test(task.id) ||
            ![
              "queued",
              "running",
              "review",
              "failed",
              "cancelled",
              "waiting_input",
              "escalated",
              "needs_rework",
            ].includes(task.status) ||
            !Array.isArray(task.files),
        )
      )
        throw Error("Invalid taskboard");
      for (const task of value) {
        const request = task.requestId ? host.sessions.requests.get(task.requestId) : undefined;
        validateTaskSelection(task, request);
        const context = request?.input.context;
        const acceptedPrompts = context && typeof context === 'object' && 'definitionPrompts' in context ? context.definitionPrompts : undefined;
        if (task.definitionPrompts !== undefined || acceptedPrompts !== undefined) {
          task.definitionPrompts = validateFeatureDefinitionPrompts(task.definitionPrompts);
          if (!task.repositoryId || !task.baseCommit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(task.baseCommit)) throw Error('Saved definition prompts require an accepted repository and source commit.');
          const reservation = { id: task.id, hash: task.submissionHash, policy: task.gatePolicy, criteria: task.criteria, repositoryId: task.repositoryId, baseCommit: task.baseCommit, definitionPrompts: task.definitionPrompts, ...(task.selectionReserved ? { selection: task.selection } : {}) };
          if (!task.submissionHash || task.submissionContextHash !== submissionContextHash(reservation)) throw Error('Saved definition prompts differ from their accepted reservation.');
          if (task.requestId && (acceptedPrompts === undefined || gateDigest(acceptedPrompts) !== gateDigest(task.definitionPrompts))) throw Error('Saved definition prompts differ from the accepted request context.');
        }
        if (task.feature) validateFeatureRequestReference(task.feature);
        const reference = host.sessions.view().records.find(record => record.id === 'local-' + task.id)?.feature;
        if (task.feature && reference && task.feature.key !== reference.key) throw Error('Saved task and session belong to different Feature Requests.');
        task.feature ??= reference ?? interactionFeatureRequest(task.id);
        if (task.implementation) {
          validateDevelopmentState(task.implementation, task.developmentEvidence);
          if (task.implementation.baseCommit !== task.baseCommit || gateDigest(task.implementation.approvedPaths) !== gateDigest(task.files.map((file: TaskFile) => file.path))) throw Error('Saved implementation scope differs from its accepted worktree.');
        } else if (task.developmentEvidence || task.developmentCompletion) throw Error('Development evidence requires accepted implementation authority.');
      }
      host.tasks = value;
      for (const task of host.tasks) await host.recoverTask(task);
      for (const task of host.tasks) {
        task.sessionId = "local-" + task.id;
        const previous = host.sessions
          .view()
          .records.find((record) => record.id === task.sessionId);
        await host.sessions.ensureTask(
          task.sessionId,
          "local",
          task.title,
          task.provider,
          task.submissionHash,
          task.definition,
          task.feature,
          localTaskSelection(task),
        );
        if (task.admissionFailure) await host.sessions.blockContinuation(task.sessionId, task.error ?? 'This interrupted request has no accepted file snapshots. Inspect its retained worktree and create a new request.');
        host.sessions.protectTask(task.sessionId, true);
        if (
          !previous ||
          previous.taskState !== undefined ||
          task.status === "queued"
        )
          await host.sessions.setTaskState(
            task.sessionId,
            task.status === "review" ? "completed" : task.status,
          );
      }
      await host.persist(host.tasks);
    }
    for (const record of host.sessions.view().records)
      if (
        record.kind === "local" &&
        ["queued", "running"].includes(record.status) &&
        !host.tasks.some((task) => task.sessionId === record.id)
      )
        await host.sessions.setTaskState(record.id, "failed");
  }

type RecoveryHost = Pick<LocalTaskRuntime, "sessions" | "outputFacts" | "restoredDevelopment" | "validatedPatch" | "writePatch">;
export async function recoverTask(host: RecoveryHost, task: LocalTask) {
  try { await recoverRetainedTask(host, task); }
  catch (error) {
    if (!(error instanceof DomainError) || error.code !== 'not_found') throw error;
    // A missing canonical entity is corruption, not permission to invent another Feature Request.
    if (task.requestId) host.sessions.requests.get(task.requestId);
    task.status = 'failed';
    task.finishedAt ??= new Date().toISOString();
    task.error = 'Saved execution evidence is missing. Inspect this Feature Request before creating an explicit successor; no model call was replayed.';
  }
}

async function recoverRetainedTask(host: RecoveryHost, task: LocalTask) {
    if (isPreparedLocalTask(task, host.sessions, host.sessions.view().records)) return;
    if (task.admissionFailure) {
      task.status = "failed";
      return;
    }
    if (task.requestId) {
      const request = host.sessions.requests.get(task.requestId);
      if (task.feature && request.owner.featureId && task.feature.key !== request.owner.featureId) throw Error('Saved task and execution belong to different Feature Requests.');
      if (
        !request.execution ||
        request.execution.inputRevision !== request.inputRevision
      ) {
        task.status = "needs_rework";
        task.finishedAt = null;
        task.error =
          "Inspect readiness and execute this accepted request revision explicitly.";
        return;
      }
    }
    if (task.requestId) {
      const request = host.sessions.requests.get(task.requestId), run = request.delivery;
      const checkpoint = run?.steps.findLast(step => ['implementing', 'repairing'].includes(step.phase) && step.turnId === task.currentTurnId && step.status === 'completed' && step.result);
      if (checkpoint && run && !request.execution?.result && !['completed', 'cancelled', 'failed', 'waiting'].includes(run.status)) {
        task.status = 'running'; task.finishedAt = null;
        task.error = run.status === 'outcome_unknown' ? 'An operation outcome needs reconciliation before continuing.' : null;
        return;
      }
    }
    const view = host.sessions.interactions.view(task.sessionId);
    const latest = view.latestTurn
      ? host.sessions.interactions.turn(task.sessionId, view.latestTurn.id)
      : null;
    const latestContext = latest?.context as { taskId?: string } | null;
    if (
      latest &&
      (latest.dispatch?.operation === "patch" ||
        latestContext?.taskId === task.id)
    ) {
      task.currentTurnId = latest.id;
      task.runId = latest.runId ?? undefined;
      if (view.phase === "cancelled") {
        task.status = "cancelled";
        task.finishedAt ??= new Date().toISOString();
        task.error ??= "Task cancelled by the operator.";
        return;
      }
    }
    if (task.currentTurnId) {
      const turn = host.sessions.interactions.turn(
        task.sessionId,
        task.currentTurnId,
      );
      if (turn.result?.type === "needs_input") {
        if (task.requestId && turn.runId)
          host.sessions.requests.recordResult(
            task.requestId,
            turn.id,
            turn.runId,
            turn.result,
            host.outputFacts(null, task),
          );
        task.status =
          turn.result.request.kind === "question"
            ? "waiting_input"
            : "escalated";
        task.finishedAt = null;
        task.error = null;
        task.summary = null;
        task.patch = null;
        return;
      }
      if (turn.result?.type === "completed") {
        const valid = task.implementation ? host.restoredDevelopment(task, turn) : host.validatedPatch(task, turn.result.text);
        if (task.requestId && turn.runId)
          host.sessions.requests.recordResult(
            task.requestId,
            turn.id,
            turn.runId,
            turn.result,
            host.outputFacts(valid, task),
          );
        if (!valid) { task.status = 'needs_rework'; task.finishedAt = turn.finishedAt; task.error = 'Required checks did not pass for the retained candidate. Continue explicitly to inspect, repair and verify it.'; return; }
        await host.writePatch(task, valid.patch);
        Object.assign(task, valid, {
          status: "review",
          finishedAt: turn.finishedAt,
          error: null,
        });
        return;
      }
      if (
        ["queued", "running", "failed", "cancelled", "interrupted"].includes(
          turn.status,
        )
      ) {
        task.status = turn.status === "cancelled" ? "cancelled" : "failed";
        task.finishedAt = turn.finishedAt ?? new Date().toISOString();
        task.error =
          "Worker stopped before this attempt was durably completed. Resume explicitly from its saved context.";
        return;
      }
    }
    if (["queued", "running"].includes(task.status)) {
      task.status = "failed";
      task.error =
        "Worker stopped before execution completed. Resume explicitly; approved inputs are preserved.";
      task.finishedAt = new Date().toISOString();
    }
  }
