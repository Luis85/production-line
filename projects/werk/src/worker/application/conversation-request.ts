import { withSessionRecovery } from './model-session-recovery.js';
import type { WorkerRequest } from "./request-gates.js";
import type { StructuredModel } from "./model-contract.js";

import { prepareModelRequest, type ModelRequest } from "./model-contract.js";
import type { InteractionCommand, InteractionTurn } from "./interactions.js";

import type { ChatMessage, Conversation, ConversationModel, ChatContext, ConversationRuntime } from './conversation-contracts.js';

interface ConversationRequestInput {
  turn?: InteractionTurn;
  command?: InteractionCommand;
  text: string;
  user: ChatMessage[];
  next: Conversation;
  gateRequest?: WorkerRequest;
}

/** Render immutable continuation context with its original provider and instruction profile. */
export function prepareConversationRequest(host: Pick<ConversationRuntime, 'timeoutMs' | 'evidence' | 'sessionId'>, model: ConversationModel, input: ConversationRequestInput) {
  const { turn, command, text, user, next, gateRequest } = input;
  const interactions = host.evidence?.interactions;
    const maxRuntimeMs =
      typeof host.timeoutMs === "function" ? host.timeoutMs() : host.timeoutMs;
    let request: ModelRequest;
    try {
      if (turn?.priorTurnId) {
        const prior = interactions!.turn(host.sessionId, turn.priorTurnId);
        if (prior.dispatch) {
          const messages = structuredClone(prior.dispatch.messages);
          if (
            (command?.action === "answer" || text) &&
            prior.result?.type === "needs_input"
          )
            messages.push({
              id: prior.id,
              role: "assistant",
              text: JSON.stringify({ werkInteraction: prior.result.request }),
              at: prior.finishedAt!,
              state: "complete",
            });
          if (text) messages.push(...user);
          // Retain the original provider/instruction profile while rendering the explicit continuation.
          request = prepareModelRequest(
            {
              ...model,
              configuration: prior.dispatch.provider,
              sessionBinding: (model as Partial<StructuredModel>).sessionBinding,
              capabilities: (model as Partial<StructuredModel>).capabilities,
              toolManifest: (model as Partial<StructuredModel>).toolManifest,
              toolManifestFor: (model as Partial<StructuredModel>).toolManifestFor?.bind(model),
              executionPolicy: (model as Partial<StructuredModel>).executionPolicy,
            } as ConversationModel,
            messages,
            "chat",
            maxRuntimeMs,
          );
        } else {
          // An answer can be durable before dispatch preparation. Recover its saved input,
          // including the accepted answer, using the nearest frozen provider profile.
          const context = prior.context as Partial<ChatContext> | null;
          let ancestor = prior;
          for (
            let depth = 0;
            !ancestor.dispatch && ancestor.priorTurnId && depth < 100;
            depth++
          )
            ancestor = interactions!.turn(host.sessionId, ancestor.priorTurnId);
          const messages = structuredClone(
            context?.chatMessages ?? next.messages,
          ).filter((item) => item.state === "complete");
          if (ancestor.result?.type === "needs_input") {
            const original = ancestor.context as Partial<ChatContext> | null;
            const question = messages.find(
              (message) => message.id === original?.assistantId,
            );
            if (question)
              question.text = JSON.stringify({
                werkInteraction: ancestor.result.request,
              });
          }
          if (text) messages.push(...user);
          const replayModel = ancestor.dispatch
            ? ({
                ...model,
                configuration: ancestor.dispatch.provider,
                sessionBinding: (model as Partial<StructuredModel>).sessionBinding,
              capabilities: (model as Partial<StructuredModel>).capabilities,
              toolManifest: (model as Partial<StructuredModel>).toolManifest,
                toolManifestFor: (model as Partial<StructuredModel>).toolManifestFor?.bind(model),
              executionPolicy: (model as Partial<StructuredModel>).executionPolicy,
              } as ConversationModel)
            : model;
          request = prepareModelRequest(replayModel, messages, "chat", maxRuntimeMs);
        }
      } else
        request = prepareModelRequest(
          gateRequest
            ? ({
                ...model,
                configuration: gateRequest.provider,
                sessionBinding: (model as Partial<StructuredModel>).sessionBinding,
              capabilities: (model as Partial<StructuredModel>).capabilities,
              toolManifest: (model as Partial<StructuredModel>).toolManifest,
                toolManifestFor: (model as Partial<StructuredModel>).toolManifestFor?.bind(model),
              executionPolicy: (model as Partial<StructuredModel>).executionPolicy,
              } as ConversationModel)
            : model,
          next.messages.filter((item) => item.state === "complete"),
          "chat",
          maxRuntimeMs,
        );
    } catch (error) {
      if (turn)
        interactions!.fail(
          host.sessionId,
          turn.id,
          "failed",
          "request_invalid",
        );
      throw error;
    }
  let prior = turn?.priorTurnId ? interactions?.turn(host.sessionId, turn.priorTurnId) : undefined;
  for (let depth = 0; prior && !prior.dispatch && prior.priorTurnId && depth < 128; depth++) prior = interactions!.turn(host.sessionId, prior.priorTurnId);
  request = withSessionRecovery(request, turn, prior, command?.operationId);
  return { request, maxRuntimeMs };
}
