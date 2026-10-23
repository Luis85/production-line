import type { SerialExecutor } from './serial-executor.js';
import { recordTaskResult } from './local-task-completion.js';
import { effectiveProjectConcurrency } from './delivery-coordination.js';
import { reconcileDeliveryReviews } from './delivery-task-review.js';
import { retainDeliveryCheckpoint } from './delivery-task-checkpoint.js';
import { providerFailureOutcome, unknownProviderOutcome } from './provider-outcome.js';
import { interactionFeatureRequest } from './feature-request-reference.js';

import { DeliverySuspended, deliveryBoundary, runDeliverySteps, taskDelivery } from './delivery-task-steps.js';

import { DEFAULT_MAX_RUNTIME_MS } from "./execution-policy.js";
import { ProviderModelError } from "./model-contract.js";

import { unknownUsage } from "./run-evidence.js";

import { localTaskConnection, validateTaskSelection } from "./local-task-selection.js";


import { PatchProtocolError } from "./patch-protocol.js";
import type { LocalTaskRuntime } from './local-task-runtime-contract.js';

export async function tick(host: Pick<LocalTaskRuntime, "closed" | "sessions" | "settings" | "tasks" | "admissionTaskId" | "preparations" | "running" | "execute" | "verifyDelivery" | "change" | "evidencePersistenceError" | "trackContinuation">) {
    if (host.closed) return;
    void host.trackContinuation(reconcileDeliveryReviews(host)).catch(() => { host.evidencePersistenceError = true; });
    const executor: SerialExecutor = host.sessions.executor;
    executor.wake();
    for (const task of host.tasks) {
      const run = taskDelivery(host, task);
      if (run?.control && ['interrupt', 'cancel'].includes(run.control.action)) host.running.get(task.id)?.controller.abort();
    }
    const limit = executor.limit;
    for (const task of host.tasks
      .filter((item) => { const run = taskDelivery(host, item); const continuing = !!run?.steps.some(step => step.phase === 'implementing' || step.phase === 'repairing'); return (item.status === 'queued' || item.status === 'running' && run?.status === 'queued') && (!host.settings.value.board.paused || continuing) && (!run || !run.control && !run.holds.length && !['paused', 'outcome_unknown', 'interrupted', 'interrupting', 'cancelled', 'failed'].includes(run.status)) && item.id !== host.admissionTaskId && !host.preparations.some(preparation => preparation.id === item.id && preparation.state === "preparing"); })
      .sort(
        (a, b) =>
          (host.settings.value.board.order === "priority"
            ? b.priority - a.priority
            : 0) || a.createdAt.localeCompare(b.createdAt),
      )) {
      if (host.running.has(task.id)) continue;
      if (host.running.size >= limit) break;
      const projectId = task.repositoryId ?? task.repository, projectLimit = effectiveProjectConcurrency(task.deliveryPolicy?.configuration.coordination, limit);
      const continuation = !!taskDelivery(host, task)?.steps.some(step => ['implementing', 'repairing'].includes(step.phase));
      if (!executor.canStart(task.sessionId, { continuation, projectId, projectLimit })) continue;
      const controller = new AbortController();
      const promise = executor
        .run(task.sessionId, controller.signal, () =>
          host.execute(task.id, controller),
          { continuation, projectId, projectLimit },
        )
        .catch(() => {})
        .finally(() => {
          host.running.delete(task.id);
          const finished = host.tasks.find((item) => item.id === task.id);
          if (finished?.requestId)
            host.sessions.notifyRequest(finished.requestId);
        });
      host.running.set(task.id, { controller, promise });
    }
  }

export async function execute(host: Pick<LocalTaskRuntime, "change" | "executionDetail" | "sessions" | "assertToolWorkspace" | "workspaceController" | "settings" | "developmentRuntime" | "model" | "evidencePersistenceError" | "writePatch" | "validatedPatch" | "outputFacts" | "input" | "completionMessage" | "tasks" | "persistenceError" | "delivery" | "authorizeDelivery">, id: string, controller: AbortController) {
    let runId: string | undefined,
      turnId: string | undefined,
      usage = unknownUsage(),
      persistenceFailed = false, retainPermit = false;
    let outcome:
      | "review"
      | "failed"
      | "cancelled"
      | "waiting_input"
      | "escalated" = "failed";
    let knownResult = false;
    let signal = controller.signal;
    try {
      await host.change((tasks) => {
        const task = tasks.find((item) => item.id === id)!;
        if (task.status !== 'queued' && !(task.status === 'running' && taskDelivery(host, task)?.status === 'queued')) throw Error('Task no longer queued');
        deliveryBoundary(host, task);
        task.status = "running";
      });
      const task = host.executionDetail(id);
      runId = task.runId;
      turnId = task.currentTurnId;
      if (!runId || !turnId)
        throw Error("Task has no reserved execution context.");
      const turn = host.sessions.interactions.turn(task.sessionId, turnId);
      if (!turn.dispatch) throw Error("Task request was not durably prepared.");
      await host.assertToolWorkspace(task, AbortSignal.any([controller.signal, host.workspaceController.signal, AbortSignal.timeout(30000)]), false, turn.dispatch.policy);
      validateTaskSelection(task, task.requestId ? host.sessions.requests.get(task.requestId) : undefined);
      const connection = localTaskConnection(host.settings.provider(task.provider), task);
      // Implementation limits come from the accepted dispatch, never from settings changed later.
      const { commandTimeoutMs, candidateSourceMaxBytes, candidateSourceMaxFiles, candidateFileMaxBytes, candidateApprovedFileMaxBytes, candidateApprovedTotalMaxBytes, candidateReviewPatchMaxBytes } = turn.dispatch.policy;
      const development = host.developmentRuntime(task, { commandTimeoutMs, candidateSourceMaxBytes, candidateSourceMaxFiles, candidateFileMaxBytes, candidateApprovedFileMaxBytes, candidateApprovedTotalMaxBytes, candidateReviewPatchMaxBytes });
      if (!!task.implementation !== (turn.dispatch.policy.development === true)) throw Error('Prepared implementation mode differs from accepted authority.');
      const model = host.model(
        connection,
        { sessionId: task.sessionId, feature: task.feature ?? interactionFeatureRequest(task.id), baseCommit: task.baseCommit, worktree: task.worktree, worktreeIdentity: task.worktreeIdentity, development },
      );
      if (!model) throw Error("Provider not configured");
      signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(
          turn.dispatch.policy.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS,
        ),
      ]);
      signal.throwIfAborted();
      const checkpoint = taskDelivery(host, task)?.steps.findLast(step => ['implementing', 'repairing'].includes(step.phase) && step.turnId === turnId && step.status === 'completed' && step.result);
      if (!checkpoint) {
        if (task.requestId) host.sessions.requests.startExecution(task.requestId, turnId, runId);
        if (turn.status === 'queued') host.sessions.interactions.start(task.sessionId, turnId);
        await host.sessions.runs.start(runId);
      } else if (turn.status !== 'running' && !turn.result) {
        host.sessions.interactions.restoreCheckpoint(task.sessionId, turnId, turn.dispatchDigest!);
      }
      const delivered = await runDeliverySteps(host, task, model, turn.dispatch, development, signal);
      const { result, valid } = delivered;
      usage = delivered.usage;
      outcome =
        result.type === "needs_input"
          ? result.request.kind === "question"
            ? "waiting_input"
            : "escalated"
          : valid ? "review" : "failed";
      // Only verified candidates can reach review; failed checks retain their completed summary for explicit rework.
      // Only validated patch completions reach the durable completed state.
      // Questions persist their checkpoint before projections, and release the execution permit.
      host.sessions.interactions.complete(
        task.sessionId,
        turnId,
        result,
        usage,
      );
      knownResult = true;
      if (task.requestId) recordTaskResult(host.sessions.requests, task.requestId, turnId, runId, result, host.outputFacts(valid, task));
      if (valid && result.type === "completed") {
        await host.writePatch(task, valid.patch);
        await host.change((tasks) => {
          Object.assign(tasks.find((item) => item.id === id)!, valid, {
            status: "review",
            finishedAt: new Date().toISOString(),
            error: null,
          });
        });
        // The raw change set stays in the interaction turn; the transcript gets a readable summary.
        await host.sessions.recordTask(
          task.sessionId,
          host.input(task),
          host.completionMessage(task, valid.summary, result.text),
        );
      } else if (result.type === 'completed') {
        await host.change(tasks => { Object.assign(tasks.find(item => item.id === id)!, { status: 'needs_rework', finishedAt: new Date().toISOString(), error: 'Required checks did not pass for the retained candidate. Continue explicitly to inspect, repair and verify it.' }); });
        await host.sessions.recordTask(task.sessionId, host.input(task), result.text);
      } else if (result.type === "needs_input") {
        await host.change((tasks) => {
          Object.assign(tasks.find((item) => item.id === id)!, {
            status: outcome,
            finishedAt: null,
            summary: null,
            patch: null,
            error: null,
          });
        });
        await host.sessions.recordTask(
          task.sessionId,
          host.input(task),
          JSON.stringify({ werkInteraction: result.request }),
        );
      }
    } catch (error) {
      if (error instanceof DeliverySuspended) return;
      const failed = host.tasks.find((task) => task.id === id);
      if (failed && turnId) {
        const saved = host.sessions.interactions.turn(failed.sessionId, turnId);
        if (saved.result) {
          knownResult = true;
          outcome =
            saved.result.type === "completed"
              ? failed.implementation && !failed.developmentCompletion?.verified ? "failed" : "review"
              : saved.result.request.kind === "question"
                ? "waiting_input"
                : "escalated";
        }
      }
      const unknown = unknownProviderOutcome(error);
      if (!knownResult && unknown && runId && failed && !taskDelivery(host, failed)) {
        try { host.sessions.runs.reserveUnknown(runId, unknown); }
        catch { const executor: SerialExecutor = host.sessions.executor; retainPermit = true; host.evidencePersistenceError = true; executor.retainUncertain(failed.sessionId); }
      }
      if (failed?.requestId) {
        const run = taskDelivery(host, failed);
        if (run?.steps.some(step => step.status === 'running')) {
          // Adapter settlement is required before this catch executes; unknown process outcomes remain visible.
          host.sessions.requests.deliveryUpdate(failed.requestId, { action: 'stopped', deliveryRunId: run.id, confirmed: !unknown, failure: !controller.signal.aborted, detail: error instanceof Error ? error.message : 'Execution stopped.' });
          if (!unknown && !host.workspaceController.signal.aborted) {
            try {
              const dispatch = turnId ? host.sessions.interactions.turn(failed.sessionId, turnId).dispatch : undefined;
              const checkpointSignal = AbortSignal.any([host.workspaceController.signal, AbortSignal.timeout(30000)]);
              await retainDeliveryCheckpoint(host, failed, host.developmentRuntime(failed, dispatch?.policy), checkpointSignal);
            } catch {
              host.sessions.requests.deliveryUpdate(failed.requestId, { action: 'hold', code: 'checkpoint_unavailable', reason: 'Stopped source remains in the retained worktree, but its Git checkpoint could not be recorded. Inspect the worktree and Git permissions before retrying.' });
            }
          }
        }
      }
      if (failed?.requestId && error instanceof ProviderModelError) {
        const failure = providerFailureOutcome(error);
        if (['authentication_required', 'rate_limited', 'quota_exhausted', 'approval_required'].includes(failure.state)) host.sessions.requests.deliveryUpdate(failed.requestId, { action: 'hold', code: 'provider_' + failure.state, reason: failure.message });
      }
      if (knownResult) persistenceFailed = true;
      else {
        outcome = !unknown && controller.signal.aborted && taskDelivery(host, failed!)?.control?.action !== 'interrupt' ? 'cancelled' : 'failed';
        const code = unknown ?? (controller.signal.aborted
          ? taskDelivery(host, failed!)?.control?.action === 'interrupt' ? 'operator_interrupted' : 'operator_cancelled'
          : signal.aborted
            ? "timeout"
            : error instanceof ProviderModelError || error instanceof PatchProtocolError
              ? error.code
              : "execution_failed");
        if (failed && turnId) {
          host.sessions.interactions.fail(
            failed.sessionId,
            turnId,
            outcome,
            code,
          );
          if (failed.requestId)
            host.sessions.requests.failExecution(
              failed.requestId,
              turnId,
              taskDelivery(host, failed)?.status === 'interrupted' ? 'interrupted' : outcome,
            );
        }
        const message = unknown && error instanceof Error ? error.message : controller.signal.aborted
          ? "Task stopped."
          : signal.aborted
            ? "This attempt reached its configured execution time limit. Resume explicitly from saved context to make another attempt."
            : error instanceof ProviderModelError
              ? error.message
              : error instanceof PatchProtocolError
                ? `The model reply did not follow the patch format: ${error.message} Resume from saved context to let the model correct it.`
                : "Task could not produce a valid patch. Check provider settings and the approved file list, then resume from saved context.";
        if (failed?.status === "running")
          await host.sessions
            .recordTask(failed.sessionId, host.input(failed), message, true)
            .catch(() => {
              persistenceFailed = true;
            });
        await host.change((tasks) => {
          const task = tasks.find((item) => item.id === id);
          if (task && task.status === "running")
            Object.assign(task, {
              status: outcome,
              finishedAt: new Date().toISOString(),
              error: message,
            });
        }).catch(() => {
          persistenceFailed = true;
        });
      }
    }
    // Ledger/projection failure cannot relabel a durably known result or trigger another model call.
    const finishedTask = host.tasks.find(item => item.id === id);
    if (runId && !retainPermit && (!finishedTask || !taskDelivery(host, finishedTask)?.handoffs?.length))
      await host.sessions.runs.finish(runId, outcome, usage).catch(() => {
        host.evidencePersistenceError = true;
      });
    if (persistenceFailed) host.persistenceError = true;
  }
