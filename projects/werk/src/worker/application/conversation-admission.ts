import { conversationProjection } from './model-context.js';
import type { StructuredModel } from './model-contract.js';
import { interactionFeatureRequest } from './feature-request-reference.js';
import type { WorkerRequest } from "./request-gates.js";
import type { ModelProvider } from "./model-contract.js";

import type { InteractionCommand, InteractionTurn } from "./interactions.js";

import { randomUUID } from "node:crypto";
import { DomainError } from "../../shared/errors.js";
import type { ChatMessage, Conversation, ConversationModel, ChatContext, ConversationRuntime } from './conversation-contracts.js';
import { prepareConversationRequest } from './conversation-request.js';
import { executeConversation } from './conversation-execution.js';

/** Admit once, persist the transcript, then start the separately owned execution attempt. */
export async function launchConversation(host: ConversationRuntime, text: string, command?: InteractionCommand, explicitRequest?: WorkerRequest) {

    if (host.closed)
      throw new DomainError("unavailable", "Worker is stopping.");
    const interactions = host.evidence?.interactions;
    const previous = host.value;
    const gates = host.evidence?.requests;
    if (!command && !explicitRequest && gates && host.evidence?.interactions) {
      const current = host.value.requestId
        ? gates.get(host.value.requestId)
        : gates.forSession(host.sessionId);
      const prior = host.evidence.interactions.view(host.sessionId);
      if (
        current &&
        current.input.kind === "chat" &&
        (["failed", "cancelled", "interrupted"].includes(current.phase) ||
          (current.phase === "ready" &&
            ["failed", "cancelled", "interrupted"].includes(current.execution?.status ?? "") &&
            ["failed", "cancelled", "interrupted"].includes(prior.latestTurn?.status ?? ""))) &&
        !current.recoveryHold &&
        prior.latestTurn &&
        current.execution?.result?.type !== "completed"
      ) {
        // Legacy follow-ups to a stopped reply are explicit continuation inputs, not a fresh root that bypasses its policy.
        command = {
          action: "resume",
          sessionId: host.sessionId,
          turnId: prior.latestTurn.id,
          expectedRevision: prior.revision,
          operationId: randomUUID(),
          message: text,
        };
      }
    }
    const at = new Date().toISOString();
    const answer: ChatMessage = {
      id: randomUUID(),
      role: "assistant",
      text: "",
      state: "pending",
      at,
    };
    const user: ChatMessage[] =
      command?.action === "resume" && !text
        ? []
        : [{ id: randomUUID(), role: "user", text, at, state: "complete" }];
    if (
      explicitRequest?.inputRevision === 1 &&
      previous.requestId === explicitRequest.id &&
      previous.messages.at(-1)?.role === "user" &&
      previous.messages.at(-1)?.text === text
    )
      user.splice(0);
    const next: Conversation = {
      messages: [...previous.messages, ...user, answer],
    };
    const requests = host.evidence?.requests;
    let gateRequest: WorkerRequest | undefined;
    let turn: InteractionTurn | undefined;
    if (requests) {
      if (
        host.changing &&
        !(
          command &&
          interactions?.operation(host.sessionId, command.operationId)
        )
      )
        throw new DomainError(
          "conflict",
          "A reply is already running. Wait or stop it first.",
        );
      if (
        command &&
        interactions?.operation(host.sessionId, command.operationId)
      ) {
        // Let the interaction journal verify exact replay identity before any new gate evaluation.
        const replay = interactions.accept({
          sessionId: host.sessionId,
          kind: command.action,
          operationId: command.operationId,
          expectedRevision: command.expectedRevision,
          pendingId: command.pendingId,
          priorTurnId: command.turnId,
          input: text,
          context: { chatMessages: next.messages, assistantId: answer.id },
        });
        if (replay.duplicate) {
          if (replay.turn.kind === 'answer' && replay.turn.priorTurnId) {
            const request = requests.forTurn(host.sessionId, replay.turn.priorTurnId);
            if (request?.execution?.turnId === replay.turn.priorTurnId && request.execution.inputRevision === request.inputRevision) requests.bindTurn(request.id, replay.turn.id, request.inputRevision, replay.turn.priorTurnId);
          }
          return;
        }
      }
      if (command) {
        const prior =
          command.turnId ?? interactions?.view(host.sessionId).pending?.turnId;
        gateRequest = prior
          ? requests.forTurn(host.sessionId, prior)
          : undefined;
        let ancestor =
          prior && interactions
            ? interactions.turn(host.sessionId, prior)
            : undefined;
        for (
          let depth = 0;
          !gateRequest && ancestor?.priorTurnId && depth < 128;
          depth++
        ) {
          gateRequest = requests.forTurn(host.sessionId, ancestor.priorTurnId);
          ancestor = interactions!.turn(host.sessionId, ancestor.priorTurnId);
        }
        if (
          gateRequest &&
          gateRequest.inputRevision > 1 &&
          !gateRequest.execution
        )
          throw new DomainError(
            "conflict",
            "Request input changed. Execute its accepted revision before continuing an older interaction.",
          );
      } else if (explicitRequest) gateRequest = explicitRequest;
      else {
        const current = host.value.requestId
          ? requests.get(host.value.requestId)
          : requests.forSession(host.sessionId);
        if (
          current &&
          current.input.kind === "chat" &&
          current.phase !== "done"
        )
          throw new DomainError(
            "conflict",
            "This request is held or awaiting input. Use its guarded request or interaction controls before starting new work.",
          );
      }
      if (!gateRequest) {
        const metadata = host.evidence!.metadata();
        const configured = (
          host.model as
            | (ConversationModel & { configuration?: ModelProvider })
            | undefined
        )?.configuration;
        const provider = configured ??
          host.evidence?.provider?.() ?? {
            id: metadata.provider,
            model: metadata.model ?? "",
            instruction: "",
          };
        gateRequest = requests.ensure({
          owner: {
            sessionId: host.sessionId,
            rootTurnId: user[0]?.id ?? answer.id,
            taskId: metadata.taskId,
            featureId: (host.evidence?.feature?.() ?? interactionFeatureRequest(metadata.taskId)).key,
          },
          input: {
            kind: "chat",
            title: text.slice(0, 120),
            message: text,
            context: { chatMessages: next.messages, assistantId: answer.id },
          },
          provider,
          policy: host.evidence?.requestPolicy?.(),
        });
      }
      next.requestId = gateRequest.id;
      const passed = requests.evaluate(gateRequest.id, "ready").passed;
      if (!passed) {
        const held: Conversation = {
          messages: next.messages.filter((item) => item.id !== answer.id),
          requestId: gateRequest.id,
        };
        await host.store.write(held);
        host.value = held;
        host.evidence?.notifyRequest?.(gateRequest.id);
        return;
      }
    }
    if (interactions) {
      if (explicitRequest && explicitRequest.inputRevision > 1) {
        const previous = interactions.view(host.sessionId);
        if (previous.pending)
          interactions.abandon(
            host.sessionId,
            previous.revision,
            "supersede-" +
              explicitRequest.id +
              "-" +
              explicitRequest.inputRevision,
            previous.pending.id,
          );
      }
      const admission = interactions.accept({
        sessionId: host.sessionId,
        kind: command?.action ?? "message",
        // The request journal deduplicates command receipts. A fresh guarded
        // execution after failed admission needs a new interaction attempt.
        operationId: command?.operationId ?? randomUUID(),
        ...(command
          ? {
              expectedRevision: command.expectedRevision,
              pendingId: command.pendingId,
              priorTurnId: command.turnId,
            }
          : {}),
        input: text,
        context: {
          chatMessages: next.messages,
          assistantId: answer.id,
        } satisfies ChatContext,
      });
      if (admission.duplicate) return;
      turn = admission.turn;
      if (gateRequest)
        requests!.bindTurn(gateRequest.id, turn.id, gateRequest.inputRevision, turn.kind === 'answer' ? turn.priorTurnId ?? undefined : undefined);
    }
    if (
      host.changing ||
      !host.model ||
      (!(host.model as Partial<StructuredModel>).sessionBinding && (host.value.messages.length >= 60 ||
      host.value.messages.reduce(
        (size, item) => size + item.text.length,
        text.length,
      ) > 48000))
    ) {
      if (turn)
        interactions!.fail(
          host.sessionId,
          turn.id,
          "failed",
          "admission_unavailable",
        );
      if (host.changing)
        throw new DomainError(
          "conflict",
          "A reply is already running. Wait or stop it first.",
        );
      if (!host.model)
        throw new DomainError(
          "unavailable",
          "No model configured. Open Dashboard to connect a provider.",
        );
      throw new DomainError(
        "conflict",
        "This task session is full. Create a new task to continue.",
      );
    }
    try {
      host.evidence?.admit?.();
    } catch (error) {
      if (turn)
        interactions!.fail(
          host.sessionId,
          turn.id,
          "failed",
          "admission_unavailable",
        );
      throw error;
    }
    const { request, maxRuntimeMs } = prepareConversationRequest(host, host.model, { turn, command, text, user, next, gateRequest });
    host.changing = true;
    host.phase = "queued";
    if (turn && (host.model as Partial<StructuredModel>).sessionBinding) next.messages = conversationProjection(next.messages);
    host.value = next;
    host.controller = new AbortController();
    const controller = host.controller;
    host.accepting = host.store.write(host.value);
    try {
      await host.accepting;
    } catch (error) {
      host.value = previous;
      host.changing = false;
      host.phase = "idle";
      if (turn)
        interactions!.fail(
          host.sessionId,
          turn.id,
          "failed",
          "transcript_write_failed",
        );
      throw error;
    }
    host.pending = executeConversation(host, { request, maxRuntimeMs, gateRequest, turn, answer, controller });
}
