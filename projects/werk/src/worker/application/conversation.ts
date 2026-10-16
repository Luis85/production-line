import type {
  GatePolicy,
  RequestGatePort,
  WorkerRequest,
} from "./request-gates.js";
import type { ModelProvider, StructuredModel } from "./model-contract.js";
import { DEFAULT_MAX_RUNTIME_MS } from "./execution-policy.js";
import {
  unknownUsage,
  type ProviderUsage,
  type RunEvidence,
  type RunMetadata,
} from "./run-evidence.js";
import {
  executeModel,
  prepareModelRequest,
  ProviderModelError,
  type ModelRequest,
} from "./model-contract.js";
import type {
  InteractionCommand,
  InteractionStore,
  InteractionTurn,
} from "./interactions.js";
import type { SerialExecutor } from "./serial-executor.js";
import { randomUUID } from "node:crypto";
import { DomainError } from "../../shared/errors.js";
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  state: "complete" | "pending" | "error" | "cancelled";
}
export interface Conversation {
  messages: ChatMessage[];
  requestId?: string;
}
export interface ConversationStore {
  read(): Promise<Conversation>;
  write(value: Conversation): Promise<void>;
}
export interface ConversationModel {
  reply(
    messages: ChatMessage[],
    signal: AbortSignal,
    onUsage?: (usage: ProviderUsage) => void,
  ): Promise<string>;
}
type Evidence = {
  journal: RunEvidence;
  metadata: () => RunMetadata;
  interactions?: InteractionStore;
  requests?: RequestGatePort;
  requestPolicy?: () => GatePolicy | undefined;
  provider?: () => ModelProvider;
  notifyRequest?: (requestId: string) => void;
  admit?: () => void;
};
type ChatContext = { chatMessages: ChatMessage[]; assistantId: string };

/** One session; persisted interaction results are authoritative over transcript projections. */
export class WorkerConversation {
  private value: Conversation = { messages: [] };
  private controller?: AbortController;
  private pending?: Promise<void>;
  private changing = false;
  private persistenceError = false;
  private store: ConversationStore;
  private model?: ConversationModel;
  private timeoutMs: number | (() => number);
  private accepting?: Promise<void>;
  private closed = false;
  private phase: "idle" | "queued" | "running" = "idle";
  private executor?: SerialExecutor;
  private sessionId: string;
  private evidence?: Evidence;

  constructor(
    store: ConversationStore,
    model?: ConversationModel,
    timeoutMs: number | (() => number) = DEFAULT_MAX_RUNTIME_MS,
    executor?: SerialExecutor,
    sessionId = "default",
    evidence?: Evidence,
  ) {
    this.store = store;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.executor = executor;
    this.sessionId = sessionId;
    this.evidence = evidence;
  }

  async init() {
    this.value = await this.store.read();
    const interactions = this.evidence?.interactions;
    const latest = interactions?.view(this.sessionId).latestTurn;
    if (latest) {
      const turn = interactions!.turn(this.sessionId, latest.id);
      const context = turn.context as Partial<ChatContext> | null;
      if (
        context &&
        Array.isArray(context.chatMessages) &&
        typeof context.assistantId === "string"
      ) {
        this.value = { messages: structuredClone(context.chatMessages) };
        const answer = this.value.messages.find(
          (message) => message.id === context.assistantId,
        );
        if (answer) this.materialize(turn, answer);
        await this.store.write(this.value);
      }
    }
    const requests = this.evidence?.requests;
    const request =
      requests?.forSession(this.sessionId) ??
      (latest ? requests?.forTurn(this.sessionId, latest.id) : undefined);
    if (request) {
      this.value.requestId = request.id;
      const turn = latest
        ? interactions!.turn(this.sessionId, latest.id)
        : null;
      if (
        request.input.kind === "chat" &&
        turn?.result &&
        turn.runId &&
        request.execution?.turnId === turn.id &&
        request.execution.inputRevision === request.inputRevision
      )
        requests!.recordResult(request.id, turn.id, turn.runId, turn.result, {
          "output.protocolValid": true,
        });
      else if (
        request.input.kind === "chat" &&
        request.execution?.result &&
        request.execution.inputRevision === request.inputRevision
      )
        requests!.evaluate(request.id, "done");
      else if (!request.execution && request.input.kind === "chat") {
        const context = request.input.context as
          | Partial<ChatContext>
          | undefined;
        if (
          Array.isArray(context?.chatMessages) &&
          typeof context.assistantId === "string"
        ) {
          this.value = {
            messages: structuredClone(context.chatMessages),
            requestId: request.id,
          };
          this.value.messages = this.value.messages.filter(
            (item) => item.id !== context.assistantId,
          );
        }
      }
      await this.store.write(this.value);
    }
    if (this.value.messages.some((message) => message.state === "pending")) {
      for (const message of this.value.messages)
        if (message.state === "pending") {
          message.state = "error";
          message.text =
            "The worker stopped before this reply finished. Resume the stopped attempt to try again.";
        }
      await this.store.write(this.value);
    }
  }

  private materialize(turn: InteractionTurn, answer: ChatMessage) {
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

  private requestView() {
    const request =
      this.value.requestId &&
      this.evidence?.requests?.get(this.value.requestId);
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
      ...structuredClone(this.value),
      ...(this.evidence?.requests ? { request: this.requestView() } : {}),
      available: !!this.model,
      busy: this.changing,
      phase: this.phase,
      persistenceError: this.persistenceError,
    };
  }

  async start(text: unknown) {
    if (typeof text !== "string" || !text.trim() || text.length > 8000)
      throw new DomainError(
        "invalid_input",
        "Send a message containing 1–8,000 characters.",
      );
    if (!this.model && !this.evidence?.requests)
      throw new DomainError(
        "unavailable",
        "No model configured. Open Dashboard to connect a provider.",
      );
    await this.launch(text.trim());
    return this.snapshot();
  }

  async interact(command: InteractionCommand) {
    if (!this.evidence?.interactions)
      throw new DomainError(
        "unavailable",
        "Durable interactions are unavailable for this session.",
      );
    const input =
      command.action === "answer" ? command.answer : (command.message ?? "");
    if (typeof input !== "string")
      throw new DomainError("invalid_input", "Provide a text answer.");
    await this.launch(input.trim(), command);
    return this.evidence.interactions.view(this.sessionId);
  }

  async executeRequest(id: string) {
    const requests = this.evidence?.requests;
    if (!requests)
      throw new DomainError("unavailable", "Request gates are unavailable.");
    const request = requests.get(id);
    if (
      request.owner.sessionId !== this.sessionId ||
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
      this.evidence?.notifyRequest?.(id);
      return this.snapshot();
    }
    await this.launch(request.input.message, undefined, requests.get(id));
    return this.snapshot();
  }
  private async launch(
    text: string,
    command?: InteractionCommand,
    explicitRequest?: WorkerRequest,
  ) {
    if (this.closed)
      throw new DomainError("unavailable", "Worker is stopping.");
    const interactions = this.evidence?.interactions;
    const previous = this.value;
    const gates = this.evidence?.requests;
    if (!command && !explicitRequest && gates && this.evidence?.interactions) {
      const current = this.value.requestId
        ? gates.get(this.value.requestId)
        : gates.forSession(this.sessionId);
      const prior = this.evidence.interactions.view(this.sessionId);
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
          sessionId: this.sessionId,
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
    const requests = this.evidence?.requests;
    let gateRequest: WorkerRequest | undefined;
    let turn: InteractionTurn | undefined;
    if (requests) {
      if (
        this.changing &&
        !(
          command &&
          interactions?.operation(this.sessionId, command.operationId)
        )
      )
        throw new DomainError(
          "conflict",
          "A reply is already running. Wait or stop it first.",
        );
      if (
        command &&
        interactions?.operation(this.sessionId, command.operationId)
      ) {
        // Let the interaction journal verify exact replay identity before any new gate evaluation.
        const replay = interactions.accept({
          sessionId: this.sessionId,
          kind: command.action,
          operationId: command.operationId,
          expectedRevision: command.expectedRevision,
          pendingId: command.pendingId,
          priorTurnId: command.turnId,
          input: text,
          context: { chatMessages: next.messages, assistantId: answer.id },
        });
        if (replay.duplicate) return;
      }
      if (command) {
        const prior =
          command.turnId ?? interactions?.view(this.sessionId).pending?.turnId;
        gateRequest = prior
          ? requests.forTurn(this.sessionId, prior)
          : undefined;
        let ancestor =
          prior && interactions
            ? interactions.turn(this.sessionId, prior)
            : undefined;
        for (
          let depth = 0;
          !gateRequest && ancestor?.priorTurnId && depth < 128;
          depth++
        ) {
          gateRequest = requests.forTurn(this.sessionId, ancestor.priorTurnId);
          ancestor = interactions!.turn(this.sessionId, ancestor.priorTurnId);
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
        const current = this.value.requestId
          ? requests.get(this.value.requestId)
          : requests.forSession(this.sessionId);
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
        const metadata = this.evidence!.metadata();
        const configured = (
          this.model as
            | (ConversationModel & { configuration?: ModelProvider })
            | undefined
        )?.configuration;
        const provider = configured ??
          this.evidence?.provider?.() ?? {
            id: metadata.provider,
            model: metadata.model ?? "",
            instruction: "",
          };
        gateRequest = requests.ensure({
          owner: {
            sessionId: this.sessionId,
            rootTurnId: user[0]?.id ?? answer.id,
            taskId: metadata.taskId,
          },
          input: {
            kind: "chat",
            title: text.slice(0, 120),
            message: text,
            context: { chatMessages: next.messages, assistantId: answer.id },
          },
          provider,
          policy: this.evidence?.requestPolicy?.(),
        });
      }
      next.requestId = gateRequest.id;
      const passed = requests.evaluate(gateRequest.id, "ready").passed;
      if (!passed) {
        const held: Conversation = {
          messages: next.messages.filter((item) => item.id !== answer.id),
          requestId: gateRequest.id,
        };
        await this.store.write(held);
        this.value = held;
        this.evidence?.notifyRequest?.(gateRequest.id);
        return;
      }
    }
    if (interactions) {
      if (explicitRequest && explicitRequest.inputRevision > 1) {
        const previous = interactions.view(this.sessionId);
        if (previous.pending)
          interactions.abandon(
            this.sessionId,
            previous.revision,
            "supersede-" +
              explicitRequest.id +
              "-" +
              explicitRequest.inputRevision,
            previous.pending.id,
          );
      }
      const admission = interactions.accept({
        sessionId: this.sessionId,
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
        requests!.bindTurn(gateRequest.id, turn.id, gateRequest.inputRevision);
    }
    if (
      this.changing ||
      !this.model ||
      this.value.messages.length >= 60 ||
      this.value.messages.reduce(
        (size, item) => size + item.text.length,
        text.length,
      ) > 48000
    ) {
      if (turn)
        interactions!.fail(
          this.sessionId,
          turn.id,
          "failed",
          "admission_unavailable",
        );
      if (this.changing)
        throw new DomainError(
          "conflict",
          "A reply is already running. Wait or stop it first.",
        );
      if (!this.model)
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
      this.evidence?.admit?.();
    } catch (error) {
      if (turn)
        interactions!.fail(
          this.sessionId,
          turn.id,
          "failed",
          "admission_unavailable",
        );
      throw error;
    }
    const maxRuntimeMs =
      typeof this.timeoutMs === "function" ? this.timeoutMs() : this.timeoutMs;
    let request: ModelRequest;
    try {
      if (turn?.priorTurnId) {
        const prior = interactions!.turn(this.sessionId, turn.priorTurnId);
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
              ...this.model,
              configuration: prior.dispatch.provider,
              toolManifest: (this.model as Partial<StructuredModel>).toolManifest,
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
            ancestor = interactions!.turn(this.sessionId, ancestor.priorTurnId);
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
          const model = ancestor.dispatch
            ? ({
                ...this.model,
                configuration: ancestor.dispatch.provider,
                toolManifest: (this.model as Partial<StructuredModel>).toolManifest,
              } as ConversationModel)
            : this.model;
          request = prepareModelRequest(model, messages, "chat", maxRuntimeMs);
        }
      } else
        request = prepareModelRequest(
          gateRequest
            ? ({
                ...this.model,
                configuration: gateRequest.provider,
                toolManifest: (this.model as Partial<StructuredModel>).toolManifest,
              } as ConversationModel)
            : this.model,
          next.messages.filter((item) => item.state === "complete"),
          "chat",
          maxRuntimeMs,
        );
    } catch (error) {
      if (turn)
        interactions!.fail(
          this.sessionId,
          turn.id,
          "failed",
          "request_invalid",
        );
      throw error;
    }
    this.changing = true;
    this.phase = "queued";
    this.value = next;
    this.controller = new AbortController();
    const controller = this.controller;
    this.accepting = this.store.write(this.value);
    try {
      await this.accepting;
    } catch (error) {
      this.value = previous;
      this.changing = false;
      this.phase = "idle";
      if (turn)
        interactions!.fail(
          this.sessionId,
          turn.id,
          "failed",
          "transcript_write_failed",
        );
      throw error;
    }
    let signal = controller.signal;
    this.pending = (async () => {
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
        if (this.evidence) {
          const metadata = this.evidence.metadata();
          if (gateRequest) {
            metadata.requestId = gateRequest.id;
            metadata.purpose = "execution";
          }
          if (request.provider.id !== "legacy") {
            metadata.provider = request.provider.id;
            metadata.model = request.provider.model;
          }
          try {
            runId = (await this.evidence.journal.begin(metadata)).id;
            if (turn)
              interactions!.prepare(this.sessionId, turn.id, request, runId);
            if (gateRequest && turn)
              requests!.prepareExecution(gateRequest.id, turn.id, runId);
          } catch (error) {
            evidenceError = true;
            throw error;
          }
        }
        release = await this.executor?.acquire(
          this.sessionId,
          controller.signal,
        );
        signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(request.policy.maxRuntimeMs ?? maxRuntimeMs),
        ]);
        this.phase = "running";
        if (runId) {
          try {
            await this.evidence!.journal.start(runId);
            if (turn) interactions!.start(this.sessionId, turn.id);
          } catch (error) {
            evidenceError = true;
            throw error;
          }
        }
        signal.throwIfAborted();
        if (gateRequest && turn && runId)
          requests!.startExecution(gateRequest.id, turn.id, runId);
        const result = await executeModel(
          this.model!,
          request,
          signal,
          (value) => {
            usage = value;
            if (runId) {
              try {
                this.evidence!.journal.observeUsage?.(runId, value);
                if (turn)
                  interactions!.observeUsage(this.sessionId, turn.id, value);
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
                interactions!.observeToolBudget(this.sessionId, turn.id, evidence);
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
          interactions!.complete(this.sessionId, turn.id, result, usage);
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
          ? interactions!.turn(this.sessionId, turn.id)
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
              interactions!.fail(this.sessionId, turn.id, outcome, code);
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
          await this.evidence!.journal.finish(runId, outcome, usage);
        } catch {
          evidenceError = true;
        }
      }
      try {
        await this.store.write(this.value);
        this.persistenceError = evidenceError;
      } catch {
        this.persistenceError = true;
      } finally {
        this.changing = false;
        this.phase = "idle";
        this.controller = undefined;
        release?.();
        if (gateRequest) this.evidence?.notifyRequest?.(gateRequest.id);
      }
    })();
  }
  async prepareTask(input: string) {
    if (this.changing)
      throw new DomainError(
        "conflict",
        "This task session is already executing.",
      );
    if (this.value.messages.length) return;
    const next: Conversation = {
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
    await this.store.write(next);
    this.value = next;
  }
  async recordTask(input: string, output: string, failed = false) {
    if (this.changing)
      throw new DomainError(
        "conflict",
        "This task session is already executing.",
      );
    const at = new Date().toISOString();
    const last = this.value.messages.at(-1);
    const request: ChatMessage[] =
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
    const messages: ChatMessage[] = [
      ...this.value.messages,
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
    const gateRequest = this.evidence?.requests?.forSession(this.sessionId);
    const next: Conversation = {
      messages,
      ...(gateRequest ? { requestId: gateRequest.id } : {}),
    };
    await this.store.write(next);
    this.value = next;
  }
  async close() {
    this.closed = true;
    this.controller?.abort();
    await this.accepting?.catch(() => {});
    await this.pending;
  }
  async cancel() {
    this.controller?.abort();
    await this.accepting?.catch(() => {});
    await this.pending;
    this.evidence?.interactions?.abandon(this.sessionId);
    const request = this.value.requestId
      ? this.evidence?.requests?.get(this.value.requestId)
      : undefined;
    if (request && !["done", "cancelled"].includes(request.phase)) {
      this.evidence!.requests!.command({
        action: "cancel",
        requestId: request.id,
        expectedRevision: request.revision,
        operationId: "cancel-" + randomUUID(),
      });
      this.evidence?.notifyRequest?.(request.id);
    }
    return this.snapshot();
  }
  async clear() {
    if (this.evidence?.requests?.hasActiveReview(this.sessionId))
      throw new DomainError(
        "conflict",
        "Cancel and drain the request reviewer before deleting this history.",
      );
    if (this.changing)
      throw new DomainError(
        "conflict",
        "Stop the current reply before starting a new conversation.",
      );
    this.changing = true;
    try {
      await this.store.write({ messages: [] });
      this.evidence?.interactions?.deleteSession(this.sessionId);
      this.evidence?.requests?.deleteSession(this.sessionId);
      this.value = { messages: [] };
      this.persistenceError = false;
    } finally {
      this.changing = false;
    }
    return this.snapshot();
  }
}
