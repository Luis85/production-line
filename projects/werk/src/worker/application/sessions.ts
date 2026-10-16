import type { SessionView } from './workspace-view.js';
import type { RequestJournal, InteractionJournal, RunJournal } from "./journal-ports.js";
import type { ModelFactory, ProviderId } from "./provider-contract.js";
import type { SessionCatalogStorage, WorkerSettingsPort } from "./workspace-ports.js";
import { settleCleanup } from "../../shared/lifecycle.js";
import type { GatePolicy } from "./request-gates.js";
import type { InteractionCommand } from "./interactions.js";
import {
  WorkerDefinitions,
  definitionConnection,
  validateSnapshot,
  type DefinitionSnapshot,
} from "./definitions.js";
import { SerialExecutor } from "./serial-executor.js";
import { randomUUID } from "node:crypto";
import { object, text, identifier } from "../../shared/contracts.js";
import { DomainError } from "../../shared/errors.js";
import { WorkerConversation } from "../application/conversation.js";
export type TaskState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "waiting_input"
  | "escalated"
  | "needs_rework";
export interface SessionRecord {
  definition?: DefinitionSnapshot;
  submissionHash?: string;
  taskState?: TaskState;
  taskId: string;
  kind: "chat" | "local" | "orchestrator";
  id: string;
  title: string;
  provider: ProviderId;
  createdAt: string;
  archived: boolean;
}
/** Worker-owned transcripts are provider-independent; native CLI session IDs never cross providers. */
export class WorkerSessions {
  readonly requests: RequestJournal;
  requestPolicy?: () => GatePolicy | undefined;
  onRequestChanged?: (requestId: string) => void;
  notifyRequest(requestId: string) {
    try {
      this.onRequestChanged?.(requestId);
    } catch {
      /* Durable review intents remain inspectable for retry. */
    }
  }
  readonly definitions: WorkerDefinitions;
  readonly runs: RunJournal;
  readonly interactions: InteractionJournal;
  private storage: SessionCatalogStorage;
  private settings: WorkerSettingsPort;
  private model: ModelFactory;
  readonly executor: SerialExecutor;
  private writes = Promise.resolve();
  private draining?: Promise<void>;
  private evidenceClosing?: Promise<void>;
  private protectedTasks = new Set<string>();
  protectTask(id: string, protectedTask: boolean) {
    if (protectedTask) this.protectedTasks.add(id);
    else this.protectedTasks.delete(id);
  }
  private records: SessionRecord[] = [];
  private selected = "default";
  private instances = new Map<string, WorkerConversation>();
  private changing = false;
  private changingProviders = false;
  private activeOutsideChat: () => number;
  constructor(settings: WorkerSettingsPort, dependencies: {
    model: ModelFactory;
    storage: SessionCatalogStorage;
    requests: RequestJournal;
    interactions: InteractionJournal;
    runs: RunJournal;
    definitions: WorkerDefinitions;
    activeOutsideChat?: () => number;
    consumptionBlocked?: () => boolean;
  }) {
    this.activeOutsideChat = dependencies.activeOutsideChat ?? (() => 0);
    this.requests = dependencies.requests;
    this.interactions = dependencies.interactions;
    this.runs = dependencies.runs;
    this.definitions = dependencies.definitions;
    this.model = dependencies.model;
    this.storage = dependencies.storage;
    this.settings = settings;
    this.executor = new SerialExecutor(() => settings.value.board.paused || !!dependencies.consumptionBlocked?.());
  }
  async init() {
    await this.requests.init();
    await this.interactions.init();
    await this.runs.init((id) => this.interactions.resultForRun(id));
    await this.definitions.init();
    const saved = await this.storage.read();
    if (saved !== undefined) {
      const value = JSON.parse(saved);
      if (
        !Array.isArray(value.records) ||
        !value.records.length ||
        value.records.length > 100 ||
        new Set(value.records.map((item: SessionRecord) => item.id)).size !==
          value.records.length
      )
        throw Error("Invalid sessions");
      for (const record of value.records) {
        identifier(record.id, "session");
        text(record.title, "Session title", 120);
        this.settings.provider(record.provider);
        if (record.definition) {
          validateSnapshot(record.definition);
          definitionConnection(
            this.settings.provider(record.provider),
            record.definition,
          );
        }
        if (
          typeof record.archived !== "boolean" ||
          !Number.isFinite(Date.parse(record.createdAt))
        )
          throw Error("Invalid session");
      }
      if (
        !value.records.some(
          (record: SessionRecord) =>
            record.id === value.selected && !record.archived,
        )
      )
        throw Error("Invalid selected session");
      this.records = value.records.map((record: SessionRecord) => ({
        ...record,
        taskId: record.taskId ?? record.id,
        kind: record.kind ?? "chat",
        taskState:
          record.kind === "orchestrator" &&
          ["running", "queued"].includes(record.taskState ?? "")
            ? "failed"
            : record.taskState,
      }));
      this.selected = value.selected;
    } else {
      this.records = [
        {
          id: "default",
          taskId: "default",
          kind: "chat",
          title: "New task",
          provider: "codex-cli",
          createdAt: new Date().toISOString(),
          archived: false,
        },
      ];
      await this.persist();
    }
    this.interactions.retainSessions(this.records.map((record) => record.id));
    for (const record of this.records) await this.load(record);
  }
  private async load(record: SessionRecord) {
    const store = await this.storage.conversation(record.id);
    const model = this.model(
      definitionConnection(
        this.settings.provider(record.provider),
        record.definition,
      ),
      { sessionId: record.id },
    );
    const conversation = new WorkerConversation(
      store,
      model,
      () => this.settings.value.execution.maxRuntimeMs,
      this.executor,
      record.id,
      {
        journal: this.runs,
        interactions: this.interactions,
        requests: this.requests,
        requestPolicy: () => this.requestPolicy?.(),
        notifyRequest: (id) => this.notifyRequest(id),
        admit: () => {
          if (
            this.chatActive + this.activeOutsideChat() >=
            this.settings.value.board.queueCapacity
          )
            throw new DomainError("conflict", "Worker task queue is full.");
        },
        provider: () => {
          const connection = definitionConnection(
            this.settings.provider(record.provider),
            record.definition,
          );
          return {
            id: connection.id,
            model: connection.model,
            instruction: connection.instruction ?? "",
          };
        },
        metadata: () => ({
          sessionId: record.id,
          taskId: record.taskId,
          kind: record.kind,
          title: record.title,
          provider: record.provider,
          model:
            record.definition?.model ||
            this.settings.provider(record.provider).model,
        }),
      },
    );
    await conversation.init();
    this.instances.set(record.id, conversation);
  }
  assertSelected(id: unknown) {
    if (id !== undefined && id !== this.selected)
      throw new DomainError(
        "conflict",
        "The selected session changed. Refresh before sending.",
      );
  }
  get chat() {
    return this.instances.get(this.selected)!;
  }
  get current() {
    return this.records.find((item) => item.id === this.selected)!;
  }
  get chatActive() {
    return [...this.instances.values()].filter((item) => item.snapshot().busy)
      .length;
  }
  get busy() {
    return (
      this.executor.busy ||
      this.records.some((record) =>
        ["queued", "running"].includes(record.taskState ?? ""),
      ) ||
      [...this.instances.values()].some((item) => item.snapshot().busy)
    );
  }
  view(): SessionView {
    return {
      selected: this.selected,
      execution: {
        currentSessionId: this.executor.current,
        queued: this.executor.waiting,
        maxParallel: 1,
      },
      records: this.records.map((record) => {
        const conversation = this.instances.get(record.id)?.snapshot(),
          last = conversation?.messages.at(-1);
        const interaction = this.interactions.view(record.id);
        const active =
          this.executor.current === record.id ||
          conversation?.busy ||
          ["queued", "running"].includes(record.taskState ?? "");
        const failedInteraction = interaction.phase === "failed" && !active;
        let status =
          failedInteraction ||
          ["waiting_input", "escalated", "cancelled", "interrupted"].includes(
            interaction.phase,
          )
            ? interaction.phase
            : this.executor.current === record.id
              ? "running"
              : conversation?.busy
                ? "queued"
                : (record.taskState ??
                  (!last
                    ? "draft"
                    : last.state === "error"
                      ? "failed"
                      : last.state === "cancelled"
                        ? "cancelled"
                        : "completed"));
        const request = this.requests.forSession(record.id);
        if (
          !active &&
          request &&
          ["readiness", "needs_rework", "review"].includes(request.phase)
        )
          status =
            request.phase === "readiness" ? "needs_rework" : request.phase;
        return {
          ...record,
          ...(request
            ? {
                requestId: request.id,
                requestPhase: request.phase,
                requestRevision: request.revision,
              }
            : {}),
          status,
          interaction,
          busy:
            (conversation?.busy ?? false) ||
            ["queued", "running"].includes(record.taskState ?? ""),
          messages: conversation?.messages.length ?? 0,
        };
      }),
    };
  }
  detail(id: string) {
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new DomainError("not_found", "Task session not found");
    return {
      session: this.view().records.find((item) => item.id === id)!,
      chat: this.instances.get(id)!.snapshot(),
    };
  }
  async executeRequest(id: string) {
    const request = this.requests.get(id);
    if (request.owner.remote || request.input.kind !== "chat")
      throw new DomainError(
        "conflict",
        "Use the owning task or orchestrator to execute this request.",
      );
    this.assertProvidersStable();
    this.detail(request.owner.sessionId);
    return this.instances.get(request.owner.sessionId)!.executeRequest(id);
  }
  async cancelTask(id: string) {
    const { session } = this.detail(id);
    if (
      session.kind !== "chat" &&
      ["queued", "running"].includes(session.taskState ?? "")
    )
      throw new DomainError(
        "conflict",
        "Use the owning taskboard or orchestrator to cancel this assignment.",
      );
    await this.instances.get(id)!.cancel();
    return this.detail(id);
  }
  async interact(command: InteractionCommand) {
    this.assertProvidersStable();
    const detail = this.detail(command.sessionId);
    if (
      detail.session.kind !== "chat" &&
      ["queued", "running"].includes(detail.session.taskState ?? "")
    )
      throw new DomainError(
        "conflict",
        "The owning task must finish before this session can continue.",
      );
    return this.instances.get(command.sessionId)!.interact(command);
  }
  async start(message: unknown, id = this.selected) {
    this.assertProvidersStable();
    this.detail(id);
    const record = this.records.find((item) => item.id === id)!,
      chat = this.instances.get(id)!;
    if (
      record.kind !== "chat" &&
      (["queued", "running"].includes(record.taskState ?? "") ||
        this.executor.current === record.id)
    )
      throw new DomainError(
        "conflict",
        "Wait for this task to finish before sending a follow-up.",
      );
    const result = await chat.start(message);
    if (record.kind !== "chat") {
      delete record.taskState;
      await this.persist();
    }
    if (
      id === this.selected &&
      record.title === "New task" &&
      typeof message === "string"
    ) {
      record.title = message.trim().slice(0, 120);
      await this.persist();
    }
    return result;
  }
  async ensureTask(
    id: string,
    kind: SessionRecord["kind"],
    title: string,
    provider: ProviderId,
    submissionHash?: string,
    definition?: DefinitionSnapshot,
  ) {
    this.assertProvidersStable();
    const found = this.records.find((record) => record.id === id);
    if (found) return found;
    if (this.changing)
      throw new DomainError(
        "conflict",
        "Session change in progress. Retry task preparation.",
      );
    if (this.records.length >= 100)
      throw new DomainError(
        "conflict",
        "Task session limit reached (100). Delete old task history before accepting more.",
      );
    this.changing = true;
    try {
      if (definition)
        definitionConnection(this.settings.provider(provider), definition);
      const record: SessionRecord = {
        ...(definition ? { definition: structuredClone(definition) } : {}),
        ...(submissionHash ? { submissionHash } : {}),
        id: identifier(id, "task session"),
        taskId: id,
        kind,
        ...(kind === "chat" ? {} : { taskState: "queued" as const }),
        title: title.slice(0, 120),
        provider,
        createdAt: new Date().toISOString(),
        archived: false,
      };
      await this.load(record);
      this.records.push(record);
      try {
        await this.persist();
      } catch (error) {
        this.records = this.records.filter((item) => item.id !== id);
        this.instances.delete(id);
        throw error;
      }
      return record;
    } finally {
      this.changing = false;
    }
  }
  async prepareTask(id: string, input: string) {
    const conversation = this.instances.get(id);
    if (!conversation)
      throw new DomainError("not_found", "Task session not found");
    await conversation.prepareTask(input);
  }
  async recordTask(id: string, input: string, output: string, failed = false) {
    const conversation = this.instances.get(id);
    if (!conversation)
      throw new DomainError("not_found", "Task session not found");
    await conversation.recordTask(input, output, failed);
  }

  async setTaskState(id: string, state: TaskState) {
    if (state === "queued" || state === "running") this.assertProvidersStable();
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new DomainError("not_found", "Task session not found");
    if (record.taskState === state) return;
    record.taskState = state;
    await this.persist();
  }
  private persist() {
    const serialized = JSON.stringify({
      selected: this.selected,
      records: this.records,
    });
    if (Buffer.byteLength(serialized) > 2097152)
      throw new DomainError(
        "conflict",
        "Task history storage is full. Delete an unused task.",
      );
    const write = this.writes
      .catch(() => {})
      .then(() =>
        this.storage.write(serialized),
      );
    this.writes = write;
    return write;
  }
  private assertProvidersStable() {
    if (this.changingProviders)
      throw new DomainError(
        "conflict",
        "Provider settings are being saved. Retry this task when saving finishes.",
      );
  }
  async updateProviders<T>(update: () => Promise<T>): Promise<T> {
    if (
      this.changing ||
      this.busy ||
      this.records.some((record) => this.requests.hasActiveReview(record.id))
    )
      throw new DomainError(
        "conflict",
        "Finish task changes and stop active replies before changing providers.",
      );
    // Reserve admission before settings persistence; loading a pending transcript would mark its live reply interrupted.
    this.changing = true;
    this.changingProviders = true;
    try {
      const result = await update();
      for (const record of this.records) {
        const previous = this.instances.get(record.id);
        await this.load(record);
        await previous?.close();
      }
      return result;
    } finally {
      this.changingProviders = false;
      this.changing = false;
    }
  }
  async reloadProviders() {
    await this.updateProviders(async () => {});
  }
  async action(input: unknown) {
    if (this.changing)
      throw new DomainError("conflict", "Session change in progress.");
    this.changing = true;
    const previous = structuredClone({
      records: this.records,
      selected: this.selected,
    });
    let deleted: string | undefined;
    let indexCommitted = false;
    try {
      const body = object(input, "Session action", [
        "action",
        "id",
        "title",
        "provider",
        "definitionId",
        "agent",
        "useInstructionsOnly",
      ]);
      if (body.action === "create") {
        if (this.records.length >= 100)
          throw new DomainError(
            "conflict",
            "Session limit reached (100). Delete an unused session first.",
          );
        const provider = this.settings.provider(String(body.provider));
        const definition = this.definitions.select(body);
        definitionConnection(provider, definition);
        const id = randomUUID();
        const record: SessionRecord = {
          ...(definition ? { definition } : {}),
          id,
          taskId: id,
          kind: "chat",
          title: text(body.title, "Session title", 120),
          provider: provider.id,
          archived: false,
          createdAt: new Date().toISOString(),
        };
        await this.load(record);
        this.records.push(record);
        this.selected = record.id;
      } else {
        if (
          body.definitionId !== undefined ||
          body.agent !== undefined ||
          body.useInstructionsOnly !== undefined
        )
          throw new DomainError(
            "invalid_input",
            "An agent definition is fixed when a task is created. Create a new task to change it.",
          );
        const record = this.records.find((item) => item.id === body.id);
        if (!record) throw new DomainError("not_found", "Session not found");
        if (body.action === "select") {
          record.archived = false;
          this.selected = record.id;
        } else if (body.action === "restore") record.archived = false;
        else if (body.action === "rename")
          record.title = text(body.title, "Session title", 120);
        else if (body.action === "archive" || body.action === "delete") {
          if (this.requests.hasActiveReview(record.id))
            throw new DomainError(
              "conflict",
              "Cancel and drain the request reviewer before archiving or deleting this history.",
            );
          if (
            this.instances.get(record.id)?.snapshot().busy ||
            this.executor.current === record.id ||
            ["queued", "running"].includes(record.taskState ?? "")
          )
            throw new DomainError("conflict", "Stop the reply first.");
          const next = this.records.find(
            (item) => item.id !== record.id && !item.archived,
          );
          if (record.id === this.selected && !next)
            throw new DomainError(
              "conflict",
              "Create another session before archiving the current one.",
            );
          if (record.id === this.selected) this.selected = next!.id;
          if (body.action === "archive") record.archived = true;
          else {
            if (this.protectedTasks.has(record.id))
              throw new DomainError(
                "conflict",
                "Delete the linked local task from History before deleting its session.",
              );
            deleted = record.id;
            this.records = this.records.filter((item) => item.id !== record.id);
          }
        } else throw new DomainError("invalid_input", "Unknown session action");
      }
      await this.persist();
      indexCommitted = true;
      // Commit the index before removing history: failed writes must preserve the existing transcript.
      if (deleted) {
        const conversation = this.instances.get(deleted)!;
        await conversation.clear().catch(() => {}); // An unindexed transcript can be cleaned up later.
        await conversation.close();
        this.instances.delete(deleted);
        this.interactions.deleteSession(deleted);
        this.requests.deleteSession(deleted);
      }
      return this.view();
    } catch (error) {
      if (indexCommitted) throw error;
      for (const id of this.instances.keys())
        if (!previous.records.some((record) => record.id === id)) {
          await this.instances.get(id)!.close();
          this.instances.delete(id);
          this.interactions.deleteSession(id);
        }
      this.records = previous.records;
      this.selected = previous.selected;
      throw error;
    } finally {
      this.changing = false;
    }
  }
  close(options: { retainEvidence?: boolean } = {}): Promise<void> {
    this.draining ??= settleCleanup([...this.instances.values()].map(item => () => item.close()));
    if (options.retainEvidence) return this.draining;
    this.evidenceClosing ??= settleCleanup(
      () => this.draining,
      [() => this.requests.close(), () => this.runs.close(), () => this.interactions.close()],
    );
    return this.evidenceClosing;
  }
}
