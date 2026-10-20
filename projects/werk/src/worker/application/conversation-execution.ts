import { conversationProjection } from './model-context.js';
import type { WorkerRequest } from "./request-gates.js";

import { unknownUsage } from "./run-evidence.js";
import { executeModel, ProviderModelError, type ModelRequest } from "./model-contract.js";
import type { InteractionTurn } from "./interactions.js";

import type { ChatMessage, ConversationRuntime } from './conversation-contracts.js';

export interface ConversationAttempt {
  request: ModelRequest;
  maxRuntimeMs: number;
  gateRequest?: WorkerRequest;
  turn?: InteractionTurn;
  answer: ChatMessage;
  controller: AbortController;
}

/** Finish durable evidence before releasing admission; a saved result is never dispatched again. */
export async function executeConversation(host: Pick<ConversationRuntime, 'evidence' | 'executor' | 'sessionId' | 'phase' | 'model' | 'store' | 'value' | 'persistenceError' | 'changing' | 'controller'>, attempt: ConversationAttempt) {
  const { request, maxRuntimeMs, gateRequest, turn, answer, controller } = attempt;
  const interactions = host.evidence?.interactions;
  const requests = host.evidence?.requests;
    let signal = controller.signal;

      let release: (() => void) | undefined,
        runId: string | undefined,
        evidenceError = false;
      let usage = unknownUsage();
      let outcome:
        | "completed"
        | "waiting_input"
        | "escalated"
        | "failed"
        | "cancelled" = "failed";
      try {
        if (host.evidence) {
          const metadata = host.evidence.metadata();
          if (gateRequest) {
            metadata.requestId = gateRequest.id;
            metadata.purpose = "execution";
          }
          if (request.provider.id !== "legacy") {
            metadata.provider = request.provider.id;
            metadata.model = request.provider.model;
            if (request.provider.authenticationMode) metadata.authenticationMode = request.provider.authenticationMode;
            else delete metadata.authenticationMode;
          }
          try {
            runId = (await host.evidence.journal.begin(metadata)).id;
            if (turn)
              interactions!.prepare(host.sessionId, turn.id, request, runId);
            if (gateRequest && turn)
              requests!.prepareExecution(gateRequest.id, turn.id, runId);
          } catch (error) {
            evidenceError = true;
            throw error;
          }
        }
        release = await host.executor?.acquire(
          host.sessionId,
          controller.signal,
        );
        signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(request.policy.maxRuntimeMs ?? maxRuntimeMs),
        ]);
        host.phase = "running";
        if (runId) {
          try {
            await host.evidence!.journal.start(runId);
            if (turn) interactions!.start(host.sessionId, turn.id);
          } catch (error) {
            evidenceError = true;
            throw error;
          }
        }
        signal.throwIfAborted();
        if (gateRequest && turn && runId)
          requests!.startExecution(gateRequest.id, turn.id, runId);
        const result = await executeModel(
          host.model!,
          request,
          signal,
          (value) => {
            usage = value;
            if (runId) {
              try {
                host.evidence!.journal.observeUsage?.(runId, value);
                if (turn)
                  interactions!.observeUsage(host.sessionId, turn.id, value);
              } catch {
                evidenceError = true;
              }
            }
          },
          {
            beforeCall() {},
            observeToolBudget: (evidence) => {
              if (!turn) return;
              try {
                interactions!.observeToolBudget(host.sessionId, turn.id, evidence);
              } catch {
                evidenceError = true;
              }
            },
          },
        );
        signal.throwIfAborted();
        if (
          result.type === "completed" &&
          (!result.text.trim() || result.text.length > 32000)
        )
          throw new ProviderModelError("protocol");
        if (turn)
          interactions!.complete(host.sessionId, turn.id, result, usage);
        answer.text =
          result.type === "completed" ? result.text : result.request.message;
        answer.state = "complete";
        outcome =
          result.type === "completed"
            ? "completed"
            : result.request.kind === "question"
              ? "waiting_input"
              : "escalated";
        if (gateRequest && turn && runId)
          requests!.recordResult(gateRequest.id, turn.id, runId, result, {
            "output.protocolValid": true,
          });
      } catch (error) {
        const saved = turn
          ? interactions!.turn(host.sessionId, turn.id)
          : undefined;
        if (saved?.result) {
          // A durable provider result is never relabeled or paid for again because a gate/projection write failed.
          answer.state = "complete";
          answer.text =
            saved.result.type === "completed"
              ? saved.result.text
              : saved.result.request.message;
          outcome =
            saved.result.type === "completed"
              ? "completed"
              : saved.result.request.kind === "question"
                ? "waiting_input"
                : "escalated";
          evidenceError = true;
        } else {
          outcome = controller.signal.aborted ? "cancelled" : "failed";
          answer.state = controller.signal.aborted ? "cancelled" : "error";
          const code = controller.signal.aborted
            ? "cancelled"
            : signal.aborted
              ? "timeout"
              : error instanceof ProviderModelError
                ? error.code
                : "execution_failed";
          answer.text = controller.signal.aborted
            ? "Reply stopped."
            : signal.aborted
              ? "This attempt reached its configured execution time limit. Its saved context is retained; resume explicitly to make another attempt."
              : error instanceof ProviderModelError
                ? error.message
                : "The model could not reply. Check this session’s provider connection and authentication, then try again.";
          if (turn) {
            try {
              interactions!.fail(host.sessionId, turn.id, outcome, code);
              if (gateRequest)
                requests!.failExecution(gateRequest.id, turn.id, outcome);
            } catch {
              evidenceError = true;
            }
          }
        }
      }
      if (runId) {
        try {
          await host.evidence!.journal.finish(runId, outcome, usage);
        } catch {
          evidenceError = true;
        }
      }
      try {
        if (turn && request.schemaVersion === 2) host.value.messages = conversationProjection(host.value.messages);
        await host.store.write(host.value);
        host.persistenceError = evidenceError;
      } catch {
        host.persistenceError = true;
      } finally {
        host.changing = false;
        host.phase = "idle";
        host.controller = undefined;
        release?.();
        if (gateRequest) host.evidence?.notifyRequest?.(gateRequest.id);
      }

}
