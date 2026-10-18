                                                        

import { DEFAULT_MAX_RUNTIME_MS } from "./execution-policy.js";

                                                            
                                                           
import { randomUUID } from "node:crypto";
import { DomainError } from "../../shared/errors.js";
                                                                                                                     
                                                                                           
import { launchConversation } from './conversation-admission.js';
import { restoreConversation } from './conversation-recovery.js';
                                                                                                                   

/** One session; persisted interaction results are authoritative over transcript projections. */
export class WorkerConversation {
                   runtime                     ;
  constructor(store                   , model                    , timeoutMs                          = DEFAULT_MAX_RUNTIME_MS, executor                 , sessionId = "default", evidence                       ) {
    this.runtime = {
      store, model, timeoutMs, executor, sessionId, evidence,
      value: { messages: [] }, changing: false, persistenceError: false, closed: false, phase: 'idle',
    };
  }
  async init() {
    await restoreConversation(this.runtime);
  }
          async launch(text        , command                     , explicitRequest                ) {
    await launchConversation(this.runtime, text, command, explicitRequest);
  }
          requestView() {
    const request =
      this.runtime.value.requestId &&
      this.runtime.evidence?.requests?.get(this.runtime.value.requestId);
    return request
      ? {
          id: request.id,
          revision: request.revision,
          inputRevision: request.inputRevision,
          phase: request.phase,
          assignee: request.assignee,
          findings: structuredClone(request.findings),
          evaluations: structuredClone(request.evaluations),
        }
      : null;
  }

  snapshot() {
    return {
      ...structuredClone(this.runtime.value),
      ...(this.runtime.evidence?.requests ? { request: this.requestView() } : {}),
      available: !!this.runtime.model,
      busy: this.runtime.changing,
      phase: this.runtime.phase,
      persistenceError: this.runtime.persistenceError,
    };
  }

  async start(text         ) {
    if (typeof text !== "string" || !text.trim() || text.length > 8000)
      throw new DomainError(
        "invalid_input",
        "Send a message containing 1–8,000 characters.",
      );
    if (!this.runtime.model && !this.runtime.evidence?.requests)
      throw new DomainError(
        "unavailable",
        "No model configured. Open Dashboard to connect a provider.",
      );
    await this.launch(text.trim());
    return this.snapshot();
  }

  async interact(command                    ) {
    if (!this.runtime.evidence?.interactions)
      throw new DomainError(
        "unavailable",
        "Durable interactions are unavailable for this session.",
      );
    const input =
      command.action === "answer" ? command.answer : (command.message ?? "");
    if (typeof input !== "string")
      throw new DomainError("invalid_input", "Provide a text answer.");
    await this.launch(input.trim(), command);
    return this.runtime.evidence.interactions.view(this.runtime.sessionId);
  }

  async executeRequest(id        ) {
    const requests = this.runtime.evidence?.requests;
    if (!requests)
      throw new DomainError("unavailable", "Request gates are unavailable.");
    const request = requests.get(id);
    if (
      request.owner.sessionId !== this.runtime.sessionId ||
      request.owner.remote ||
      request.input.kind !== "chat"
    )
      throw new DomainError(
        "conflict",
        "This request belongs to another execution owner.",
      );
    if (request.execution?.inputRevision === request.inputRevision)
      return this.snapshot();
    if (!requests.evaluate(id, "ready").passed) {
      this.runtime.evidence?.notifyRequest?.(id);
      return this.snapshot();
    }
    await this.launch(request.input.message, undefined, requests.get(id));
    return this.snapshot();
  }

  async prepareTask(input        ) {
    if (this.runtime.changing)
      throw new DomainError(
        "conflict",
        "This task session is already executing.",
      );
    if (this.runtime.value.messages.length) return;
    const next               = {
      messages: [
        {
          id: randomUUID(),
          role: "user",
          text: input.slice(0, 8000),
          at: new Date().toISOString(),
          state: "complete",
        },
      ],
    };
    await this.runtime.store.write(next);
    this.runtime.value = next;
  }

  async recordTask(input        , output        , failed = false) {
    if (this.runtime.changing)
      throw new DomainError(
        "conflict",
        "This task session is already executing.",
      );
    const at = new Date().toISOString();
    const last = this.runtime.value.messages.at(-1);
    const request                =
      last?.role === "user" && last.text === input.slice(0, 8000)
        ? []
        : [
            {
              id: randomUUID(),
              role: "user",
              text: input.slice(0, 8000),
              at,
              state: "complete",
            },
          ];
    const messages                = [
      ...this.runtime.value.messages,
      ...request,
      {
        id: randomUUID(),
        role: "assistant",
        text: output.slice(0, 16000),
        at,
        state: failed ? "error" : "complete",
      },
    ];
    while (
      messages.length > 2 &&
      (messages.length > 60 ||
        messages.reduce((size, message) => size + message.text.length, 0) >
          48000)
    )
      messages.splice(0, 2);
    const gateRequest = this.runtime.evidence?.requests?.forSession(this.runtime.sessionId);
    const next               = {
      messages,
      ...(gateRequest ? { requestId: gateRequest.id } : {}),
    };
    await this.runtime.store.write(next);
    this.runtime.value = next;
  }

  async close() {
    this.runtime.closed = true;
    this.runtime.controller?.abort();
    await this.runtime.accepting?.catch(() => {});
    await this.runtime.pending;
  }

  async cancel() {
    this.runtime.controller?.abort();
    await this.runtime.accepting?.catch(() => {});
    await this.runtime.pending;
    this.runtime.evidence?.interactions?.abandon(this.runtime.sessionId);
    const request = this.runtime.value.requestId
      ? this.runtime.evidence?.requests?.get(this.runtime.value.requestId)
      : undefined;
    if (request && !["done", "cancelled"].includes(request.phase)) {
      this.runtime.evidence .requests .command({
        action: "cancel",
        requestId: request.id,
        expectedRevision: request.revision,
        operationId: "cancel-" + randomUUID(),
      });
      this.runtime.evidence?.notifyRequest?.(request.id);
    }
    return this.snapshot();
  }

  async clear() {
    if (this.runtime.evidence?.requests?.hasActiveReview(this.runtime.sessionId))
      throw new DomainError(
        "conflict",
        "Cancel and drain the request reviewer before deleting this history.",
      );
    if (this.runtime.changing)
      throw new DomainError(
        "conflict",
        "Stop the current reply before starting a new conversation.",
      );
    this.runtime.changing = true;
    try {
      await this.runtime.store.write({ messages: [] });
      this.runtime.evidence?.interactions?.deleteSession(this.runtime.sessionId);
      this.runtime.evidence?.requests?.deleteSession(this.runtime.sessionId);
      this.runtime.value = { messages: [] };
      this.runtime.persistenceError = false;
    } finally {
      this.runtime.changing = false;
    }
    return this.snapshot();
  }

}
