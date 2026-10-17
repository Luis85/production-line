
import { developmentVerified, validateDevelopmentState } from './development.js';

import { gateDigest } from "./request-gates.js";
import { DEFAULT_MAX_RUNTIME_MS } from "./execution-policy.js";
import { executeModel, ProviderModelError } from "./model-contract.js";

import { unknownUsage } from "./run-evidence.js";

import { definitionConnection } from "./definitions.js";


import { PatchProtocolError } from "./patch-protocol.js";
import { fingerprint } from './local-task-contracts.js';
import type { LocalTaskRuntime } from './local-task-runtime-contract.js';

export async function tick(host: Pick<LocalTaskRuntime, "closed" | "sessions" | "settings" | "tasks" | "admissionTaskId" | "preparations" | "running" | "execute">) {
    if (host.closed) return;
    host.sessions.executor.wake();
    if (host.settings.value.board.paused) return;
    const limit = 1;
    for (const task of host.tasks
      .filter((item) => item.status === "queued" && item.id !== host.admissionTaskId && !host.preparations.some(preparation => preparation.id === item.id && preparation.state === "preparing"))
      .sort(
        (a, b) =>
          (host.settings.value.board.order === "priority"
            ? b.priority - a.priority
            : 0) || a.createdAt.localeCompare(b.createdAt),
      )) {
      if (host.running.size >= limit || host.running.has(task.id)) break;
      const controller = new AbortController();
      const promise = host.sessions.executor
        .run(task.sessionId, controller.signal, () =>
          host.execute(task.id, controller),
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

export async function execute(host: Pick<LocalTaskRuntime, "change" | "executionDetail" | "sessions" | "assertToolWorkspace" | "workspaceController" | "settings" | "developmentRuntime" | "model" | "evidencePersistenceError" | "writePatch" | "validatedPatch" | "outputFacts" | "input" | "completionMessage" | "tasks" | "persistenceError">, id: string, controller: AbortController) {
    let runId: string | undefined,
      turnId: string | undefined,
      usage = unknownUsage(),
      persistenceFailed = false;
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
        if (task.status !== "queued") throw Error("Task no longer queued");
        task.status = "running";
      });
      const task = host.executionDetail(id);
      runId = task.runId;
      turnId = task.currentTurnId;
      if (!runId || !turnId)
        throw Error("Task has no reserved execution context.");
      const turn = host.sessions.interactions.turn(task.sessionId, turnId);
      if (!turn.dispatch) throw Error("Task request was not durably prepared.");
      await host.assertToolWorkspace(task, AbortSignal.any([controller.signal, host.workspaceController.signal, AbortSignal.timeout(30000)]));
      const connection = {
        ...host.settings.provider(task.provider),
        model: task.model,
      };
      const development = host.developmentRuntime(task, turn.dispatch.policy.commandTimeoutMs);
      if (!!task.implementation !== (turn.dispatch.policy.development === true)) throw Error('Prepared implementation mode differs from accepted authority.');
      const model = host.model(
        definitionConnection(connection, task.definition),
        { worktree: task.worktree, worktreeIdentity: task.worktreeIdentity, development },
      );
      if (!model) throw Error("Provider not configured");
      signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(
          turn.dispatch.policy.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS,
        ),
      ]);
      signal.throwIfAborted();
      if (task.requestId)
        host.sessions.requests.startExecution(task.requestId, turnId, runId);
      host.sessions.interactions.start(task.sessionId, turnId);
      await host.sessions.runs.start(runId);
      const result = await executeModel(
        model,
        turn.dispatch,
        signal,
        (value) => {
          usage = value;
          try {
            host.sessions.runs.observeUsage(runId!, value);
            host.sessions.interactions.observeUsage(
              task.sessionId,
              turnId!,
              value,
            );
          } catch {
            host.evidencePersistenceError = true;
          }
        },
        {
          beforeCall() {},
          observeToolBudget: (evidence) => {
            try {
              host.sessions.interactions.observeToolBudget(
                task.sessionId,
                turnId!,
                evidence,
              );
            } catch {
              host.evidencePersistenceError = true;
            }
          },
        },
      );
      signal.throwIfAborted();
      let valid: { summary: string; patch: string; changedFileCount: number } | null = null;
      if (result.type === 'completed') {
        if (development && task.implementation) {
          const candidate = await development.capture(signal), evidence = development.evidence();
          validateDevelopmentState(task.implementation, evidence);
          const verified = developmentVerified(task.implementation, candidate, evidence);
          const receipt = { turnId, runId, candidateDigest: candidate.digest, patchSha256: fingerprint(candidate.patch), evidenceDigest: gateDigest(evidence), verified };
          if (candidate.patch) await host.writePatch(task, candidate.patch);
          await host.change(tasks => { const current = tasks.find(item => item.id === id)!;
            current.developmentEvidence = structuredClone(evidence); current.developmentCompletion = receipt;
            current.patch = candidate.patch || null; current.summary = result.text; current.changedFileCount = candidate.changedPaths.length;
          });
          Object.assign(task, { developmentEvidence: evidence, developmentCompletion: receipt, patch: candidate.patch, summary: result.text });
          if (verified) valid = { summary: result.text, patch: candidate.patch, changedFileCount: candidate.changedPaths.length };
        } else valid = host.validatedPatch(task, result.text);
      }
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
      if (task.requestId)
        host.sessions.requests.recordResult(
          task.requestId,
          turnId,
          runId,
          result,
          host.outputFacts(valid, task),
        );
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
      if (knownResult) persistenceFailed = true;
      else {
        outcome = controller.signal.aborted ? "cancelled" : "failed";
        const code = controller.signal.aborted
          ? "operator_cancelled"
          : signal.aborted
            ? "timeout"
            : error instanceof ProviderModelError || error instanceof PatchProtocolError
              ? error.code
              : "execution_failed";
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
              outcome,
            );
        }
        const message = controller.signal.aborted
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
    if (runId)
      await host.sessions.runs.finish(runId, outcome, usage).catch(() => {
        host.evidencePersistenceError = true;
      });
    if (persistenceFailed) host.persistenceError = true;
  }
