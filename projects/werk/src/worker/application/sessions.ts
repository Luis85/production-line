import { restoreFeatureRequestReferences } from './feature-request-migration.js';
import { sessionFeatureRequest, validateFeatureRequestReference, type FeatureRequestReference } from './feature-request-reference.js';
import { restoreSessionCatalog, type SessionCatalog, type SessionRecord, type TaskState } from './session-catalog.js';
import { sessionAction } from './session-actions.js';
import { sessionView } from './session-view.js';
import { loadSessionConversation } from './session-conversation.js';
import { SerializedOperations } from '../../shared/serialized-operations.js';
import type { FeatureTrackingRecord, FeatureTrackingStatus } from './feature-tracking.js';
import { type WorkerCapacityContext } from './worker-capacity.js';
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
  type DefinitionSnapshot,
} from "./definitions.js";
import { SerialExecutor } from "./serial-executor.js";
import { text, identifier } from "../../shared/contracts.js";
import { DomainError } from "../../shared/errors.js";
import type { WorkerConversation } from "../application/conversation.js";
export type { SessionRecord, TaskState } from "./session-catalog.js";
/** Worker-owned transcripts are provider-independent; native CLI session IDs never cross providers. */
export class WorkerSessions {
  featureTracking?: { status(): FeatureTrackingStatus; record(sessionId: string): FeatureTrackingRecord | undefined };
  featureSource?: (record: SessionRecord) => FeatureRequestReference | undefined;
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
  private readonly writes = new SerializedOperations();
  private draining?: Promise<void>;
  private evidenceClosing?: Promise<void>;
  private protectedTasks = new Set<string>();
  protectTask(id: string, protectedTask: boolean) {
    if (protectedTask) this.protectedTasks.add(id);
    else this.protectedTasks.delete(id);
  }
  private catalog: SessionCatalog = { records: [], selected: "default", changing: false };
  private instances = new Map<string, WorkerConversation>();
  private changingProviders = false;
  private activeOutsideChat: () => number;
  private capacityContext?: WorkerCapacityContext;
  constructor(settings: WorkerSettingsPort, dependencies: {
    model: ModelFactory;
    storage: SessionCatalogStorage;
    requests: RequestJournal;
    interactions: InteractionJournal;
    runs: RunJournal;
    definitions: WorkerDefinitions;
    activeOutsideChat?: () => number;
    consumptionBlocked?: () => boolean;
    capacity?: WorkerCapacityContext;
  }) {
    this.activeOutsideChat = dependencies.activeOutsideChat ?? (() => 0);
    this.capacityContext = dependencies.capacity;
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
    this.catalog = restoreSessionCatalog(saved, this.settings);
    const migrated = restoreFeatureRequestReferences(this.catalog.records, this.requests, this.featureSource);
    if (migrated || saved === undefined) await this.persist();
    this.interactions.retainSessions(this.catalog.records.map((record) => record.id));
    for (const record of this.catalog.records) await this.load(record);
  }
  private async load(record: SessionRecord) {
    await loadSessionConversation({
      storage: this.storage, settings: this.settings, model: this.model, executor: this.executor,
      runs: this.runs, interactions: this.interactions, requests: this.requests, instances: this.instances,
      requestPolicy: () => this.requestPolicy?.(), notifyRequest: id => this.notifyRequest(id),
      assertCanContinue: id => this.assertCanContinue(id), chatActive: () => this.chatActive,
      activeOutsideChat: () => this.activeOutsideChat(),
    }, record);
  }
  assertSelected(id: unknown) {
    if (id !== undefined && id !== this.catalog.selected)
      throw new DomainError(
        "conflict",
        "The selected session changed. Refresh before sending.",
      );
  }
  get chat() {
    return this.instances.get(this.catalog.selected)!;
  }
  get current() {
    return this.catalog.records.find((item) => item.id === this.catalog.selected)!;
  }
  get chatActive() {
    return [...this.instances.values()].filter((item) => item.snapshot().busy)
      .length;
  }
  get busy() {
    return (
      this.executor.busy ||
      this.catalog.records.some((record) =>
        ["queued", "running"].includes(record.taskState ?? ""),
      ) ||
      [...this.instances.values()].some((item) => item.snapshot().busy)
    );
  }
  view(): SessionView {
    return sessionView({
      catalog: this.catalog, featureTracking: this.featureTracking, capacityContext: this.capacityContext,
      settings: this.settings, instances: this.instances, requests: this.requests,
      interactions: this.interactions, executor: this.executor, chatActive: this.chatActive,
      activeOutsideChat: () => this.activeOutsideChat(),
    });
  }
  details() {
    return this.view().records.map(session => ({ session, chat: this.instances.get(session.id)!.snapshot() }));
  }
  detail(id: string) {
    const record = this.catalog.records.find((item) => item.id === id);
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
    this.assertCanContinue(command.sessionId);
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
  async start(message: unknown, id = this.catalog.selected) {
    this.assertProvidersStable();
    this.assertCanContinue(id);
    this.detail(id);
    const record = this.catalog.records.find((item) => item.id === id)!,
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
      id === this.catalog.selected &&
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
    feature?: FeatureRequestReference,
  ) {
    this.assertProvidersStable();
    const reference = feature && validateFeatureRequestReference(feature);
    const found = this.catalog.records.find((record) => record.id === id);
    if (found) {
      if (reference && found.feature && found.feature.key !== reference.key)
        throw new DomainError('conflict', 'This session belongs to another feature request.');
      if (reference && !found.feature) {
        found.feature = reference;
        try { await this.persist(); } catch (error) { delete found.feature; throw error; }
        this.requests.bindFeature(id, reference.key);
      }
      return found;
    }
    if (this.catalog.changing)
      throw new DomainError(
        "conflict",
        "Session change in progress. Retry task preparation.",
      );
    if (this.catalog.records.length >= 100)
      throw new DomainError(
        "conflict",
        "Task session limit reached (100). Delete old task history before accepting more.",
      );
    this.catalog.changing = true;
    try {
      if (definition)
        definitionConnection(this.settings.provider(provider), definition);
      const record: SessionRecord = {
        ...(definition ? { definition: structuredClone(definition) } : {}),
        ...(submissionHash ? { submissionHash } : {}),
        id: identifier(id, "task session"),
        taskId: id,
        feature: feature ? validateFeatureRequestReference(feature) : sessionFeatureRequest({ id, kind }),
        kind,
        ...(kind === "chat" ? {} : { taskState: "queued" as const }),
        title: title.slice(0, 120),
        provider,
        createdAt: new Date().toISOString(),
        archived: false,
      };
      await this.load(record);
      this.catalog.records.push(record);
      try {
        await this.persist();
      } catch (error) {
        this.catalog.records = this.catalog.records.filter((item) => item.id !== id);
        this.instances.delete(id);
        throw error;
      }
      return record;
    } finally {
      this.catalog.changing = false;
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

  private assertCanContinue(id: string) {
    const record = this.catalog.records.find(record => record.id === id);
    if (record?.continuationBlockedReason) throw new DomainError('conflict', record.continuationBlockedReason);
  }
  async blockContinuation(id: string, reason: string) {
    const record = this.catalog.records.find(record => record.id === id);
    if (!record) throw new DomainError('not_found', 'Task session not found');
    record.continuationBlockedReason = text(reason, 'Continuation block reason', 1000);
    record.taskState = 'failed';
    // Retain the block in memory on write failure; every retry persists it again.
    await this.persist();
  }
  async setTaskState(id: string, state: TaskState) {
    if (state === "queued" || state === "running") this.assertProvidersStable();
    const record = this.catalog.records.find((item) => item.id === id);
    if (!record) throw new DomainError("not_found", "Task session not found");
    if (record.taskState === state) return;
    record.taskState = state;
    await this.persist();
  }
  private persist() {
    const serialized = JSON.stringify({
      selected: this.catalog.selected,
      records: this.catalog.records,
    });
    if (Buffer.byteLength(serialized) > 2097152)
      throw new DomainError(
        "conflict",
        "Task history storage is full. Delete an unused task.",
      );
    return this.writes.run(() => this.storage.write(serialized));
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
      this.catalog.changing ||
      this.busy ||
      this.catalog.records.some((record) => this.requests.hasActiveReview(record.id))
    )
      throw new DomainError(
        "conflict",
        "Finish task changes and stop active replies before changing providers.",
      );
    // Reserve admission before settings persistence; loading a pending transcript would mark its live reply interrupted.
    this.catalog.changing = true;
    this.changingProviders = true;
    try {
      const result = await update();
      for (const record of this.catalog.records) {
        const previous = this.instances.get(record.id);
        await this.load(record);
        await previous?.close();
      }
      return result;
    } finally {
      this.changingProviders = false;
      this.catalog.changing = false;
    }
  }
  async reloadProviders() {
    await this.updateProviders(async () => {});
  }
  async action(input: unknown) {
    return sessionAction({
      catalog: this.catalog, settings: this.settings, definitions: this.definitions,
      instances: this.instances, requests: this.requests, interactions: this.interactions,
      executor: this.executor, protectedTasks: this.protectedTasks,
      load: record => this.load(record), persist: () => this.persist(), view: () => this.view(),
    }, input);
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
