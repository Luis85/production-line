import { conversationProjection } from './model-context.js';


                                                         

                                                                                                 

export async function restoreConversation(host                                                                         ) {
    host.value = await host.store.read();
    const interactions = host.evidence?.interactions;
    const latest = interactions?.view(host.sessionId).latestTurn;
    const versioned = latest && interactions .turn(host.sessionId, latest.id).dispatch?.schemaVersion === 2;
    if (latest) {
      const turn = interactions .turn(host.sessionId, latest.id);
      const context = turn.context                               ;
      if (
        context &&
        Array.isArray(context.chatMessages) &&
        typeof context.assistantId === "string"
      ) {
        host.value = { messages: structuredClone(context.chatMessages) };
        const answer = host.value.messages.find(
          (message) => message.id === context.assistantId,
        );
        if (answer) materialize(turn, answer);
        if (versioned) host.value.messages = conversationProjection(host.value.messages);
      await host.store.write(host.value);
      }
    }
    const requests = host.evidence?.requests;
    const request =
      requests?.forSession(host.sessionId) ??
      (latest ? requests?.forTurn(host.sessionId, latest.id) : undefined);
    if (request) {
      host.value.requestId = request.id;
      const turn = latest
        ? interactions .turn(host.sessionId, latest.id)
        : null;
      if (
        request.input.kind === "chat" &&
        turn?.result &&
        turn.runId &&
        request.execution?.turnId === turn.id &&
        request.execution.inputRevision === request.inputRevision
      )
        requests .recordResult(request.id, turn.id, turn.runId, turn.result, {
          "output.protocolValid": true,
        });
      else if (
        request.input.kind === "chat" &&
        request.execution?.result &&
        request.execution.inputRevision === request.inputRevision
      )
        requests .evaluate(request.id, "done");
      else if (!request.execution && request.input.kind === "chat") {
        const context = request.input.context   
                                
                     ;
        if (
          Array.isArray(context?.chatMessages) &&
          typeof context.assistantId === "string"
        ) {
          host.value = {
            messages: structuredClone(context.chatMessages),
            requestId: request.id,
          };
          host.value.messages = host.value.messages.filter(
            (item) => item.id !== context.assistantId,
          );
        }
      }
      if (versioned) host.value.messages = conversationProjection(host.value.messages);
      await host.store.write(host.value);
    }
    if (host.value.messages.some((message) => message.state === "pending")) {
      for (const message of host.value.messages)
        if (message.state === "pending") {
          message.state = "error";
          message.text =
            "The worker stopped before this reply finished. Resume the stopped attempt to try again.";
        }
      if (versioned) host.value.messages = conversationProjection(host.value.messages);
      await host.store.write(host.value);
    }
  }

function materialize(turn                 , answer             ) {
    if (turn.result) {
      answer.state = "complete";
      answer.text =
        turn.result.type === "completed"
          ? turn.result.text
          : turn.result.request.message;
    } else {
      answer.state = turn.status === "cancelled" ? "cancelled" : "error";
      answer.text =
        turn.status === "cancelled"
          ? "Reply stopped."
          : "This attempt did not finish. Resume it explicitly to make a new model request.";
    }
  }
