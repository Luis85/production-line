import { restoreFeatureRequestReferences } from './feature-request-migration.js';
import { sessionFeatureRequest, validateFeatureRequestReference,                              } from './feature-request-reference.js';
import { restoreSessionCatalog,                                                         } from './session-catalog.js';
import { sessionAction } from './session-actions.js';
import { sessionView } from './session-view.js';
import { loadSessionConversation } from './session-conversation.js';
import { SerializedOperations } from '../../shared/serialized-operations.js';
                                                                                          
import {                            } from './worker-capacity.js';
                                                       
                                                                                         
                                                                       
                                                                                      
import { settleCleanup } from "../../shared/lifecycle.js";
                                                     
                                                            
import {
  WorkerDefinitions,
  definitionConnection,
                          
} from "./definitions.js";
import { SerialExecutor } from "./serial-executor.js";
import { text, identifier } from "../../shared/contracts.js";
import { DomainError } from "../../shared/errors.js";
                                                                         
                                                                     
/** Worker-owned transcripts are provider-independent; native CLI session IDs never cross providers. */
export class WorkerSessions {
  featureTracking                                                                                                    ;
  featureSource                                                                 ;
           requests                ;
  requestPolicy                               ;
  onRequestChanged                              ;
  notifyRequest(requestId        ) {
    try {
      this.onRequestChanged?.(requestId);
    } catch {
      /* Durable review intents remain inspectable for retry. */
    }
  }
           definitions                   ;
           runs            ;
           interactions                    ;
          storage                       ;
          settings                    ;
          model              ;
           executor                ;
                   writes = new SerializedOperations();
          draining                ;
          evidenceClosing                ;
          protectedTasks = new Set        ();
  protectTask(id        , protectedTask         ) {
    if (protectedTask) this.protectedTasks.add(id);
    else this.protectedTasks.delete(id);
  }
          catalog                 = { records: [], selected: "default", changing: false };
          instances = new Map                            ();
          changingProviders = false;
          activeOutsideChat              ;
          capacityContext                        ;
          initializeEvidence                      ;
  constructor(settings                    , dependencies   
                        
                                   
                             
                                     
                     
                                   
                                     
                                       
                                     
                                             
   ) {
    this.activeOutsideChat = dependencies.activeOutsideChat ?? (() => 0);
    this.capacityContext = dependencies.capacity;
    this.initializeEvidence = dependencies.initializeEvidence;
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
    if (this.initializeEvidence) await this.initializeEvidence();
    else {
      await this.requests.init();
      await this.interactions.init();
      await this.runs.init((id) => this.interactions.resultForRun(id));
    }
    await this.definitions.init();
    const saved = await this.storage.read();
    this.catalog = restoreSessionCatalog(saved, this.settings);
    const migrated = restoreFeatureRequestReferences(this.catalog.records, this.requests, this.featureSource);
    if (migrated || saved === undefined) await this.persist();
    this.interactions.retainSessions(this.catalog.records.map((record) => record.id));
    for (const record of this.catalog.records) await this.load(record);
  }
          async load(record               ) {
    await loadSessionConversation({
      storage: this.storage, settings: this.settings, model: this.model, executor: this.executor,
      runs: this.runs, interactions: this.interactions, requests: this.requests, instances: this.instances,
      requestPolicy: () => this.requestPolicy?.(), notifyRequest: id => this.notifyRequest(id),
      assertCanContinue: id => this.assertCanContinue(id), chatActive: () => this.chatActive,
      activeOutsideChat: () => this.activeOutsideChat(),
    }, record);
  }
  assertSelected(id         ) {
    if (id !== undefined && id !== this.catalog.selected)
      throw new DomainError(
        "conflict",
        "The selected session changed. Refresh before sending.",
      );
  }
  get chat() {
    return this.instances.get(this.catalog.selected) ;
  }
  get current() {
    return this.catalog.records.find((item) => item.id === this.catalog.selected) ;
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
  view()              {
    return sessionView({
      catalog: this.catalog, featureTracking: this.featureTracking, capacityContext: this.capacityContext,
      settings: this.settings, instances: this.instances, requests: this.requests,
      interactions: this.interactions, executor: this.executor, chatActive: this.chatActive,
      activeOutsideChat: () => this.activeOutsideChat(),
    });
  }
  details() {
    return this.view().records.map(session => ({ session, chat: this.instances.get(session.id) .snapshot() }));
  }
  detail(id        ) {
    const record = this.catalog.records.find((item) => item.id === id);
    if (!record) throw new DomainError("not_found", "Task session not found");
    return {
      session: this.view().records.find((item) => item.id === id) ,
      chat: this.instances.get(id) .snapshot(),
    };
  }
  async executeRequest(id        ) {
    const request = this.requests.get(id);
    if (request.owner.remote || request.input.kind !== "chat")
      throw new DomainError(
        "conflict",
        "Use the owning task or orchestrator to execute this request.",
      );
    this.assertProvidersStable();
    this.detail(request.owner.sessionId);
    return this.instances.get(request.owner.sessionId) .executeRequest(id);
  }
  async cancelTask(id        ) {
    const { session } = this.detail(id);
    if (
      session.kind !== "chat" &&
      ["queued", "running"].includes(session.taskState ?? "")
    )
      throw new DomainError(
        "conflict",
        "Use the owning taskboard or orchestrator to cancel this assignment.",
      );
    await this.instances.get(id) .cancel();
    return this.detail(id);
  }
  async interact(command                    ) {
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
    return this.instances.get(command.sessionId) .interact(command);
  }
  async start(message         , id = this.catalog.selected) {
    this.assertProvidersStable();
    this.assertCanContinue(id);
    this.detail(id);
    const record = this.catalog.records.find((item) => item.id === id) ,
      chat = this.instances.get(id) ;
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
    id        ,
    kind                       ,
    title        ,
    provider            ,
    submissionHash         ,
    definition                     ,
    feature                          ,
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
      const record                = {
        ...(definition ? { definition: structuredClone(definition) } : {}),
        ...(submissionHash ? { submissionHash } : {}),
        id: identifier(id, "task session"),
        taskId: id,
        feature: feature ? validateFeatureRequestReference(feature) : sessionFeatureRequest({ id, kind }),
        kind,
        ...(kind === "chat" ? {} : { taskState: "queued"          }),
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
  async prepareTask(id        , input        ) {
    const conversation = this.instances.get(id);
    if (!conversation)
      throw new DomainError("not_found", "Task session not found");
    await conversation.prepareTask(input);
  }
  async recordTask(id        , input        , output        , failed = false) {
    const conversation = this.instances.get(id);
    if (!conversation)
      throw new DomainError("not_found", "Task session not found");
    await conversation.recordTask(input, output, failed);
  }

          assertCanContinue(id        ) {
    const record = this.catalog.records.find(record => record.id === id);
    if (record?.continuationBlockedReason) throw new DomainError('conflict', record.continuationBlockedReason);
  }
  async blockContinuation(id        , reason        ) {
    const record = this.catalog.records.find(record => record.id === id);
    if (!record) throw new DomainError('not_found', 'Task session not found');
    record.continuationBlockedReason = text(reason, 'Continuation block reason', 1000);
    record.taskState = 'failed';
    // Retain the block in memory on write failure; every retry persists it again.
    await this.persist();
  }
  async setTaskState(id        , state           ) {
    if (state === "queued" || state === "running") this.assertProvidersStable();
    const record = this.catalog.records.find((item) => item.id === id);
    if (!record) throw new DomainError("not_found", "Task session not found");
    if (record.taskState === state) return;
    record.taskState = state;
    await this.persist();
  }
          persist() {
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
          assertProvidersStable() {
    if (this.changingProviders)
      throw new DomainError(
        "conflict",
        "Provider settings are being saved. Retry this task when saving finishes.",
      );
  }
  async updateProviders   (update                  )             {
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
  async action(input         ) {
    return sessionAction({
      catalog: this.catalog, settings: this.settings, definitions: this.definitions,
      instances: this.instances, requests: this.requests, interactions: this.interactions,
      executor: this.executor, protectedTasks: this.protectedTasks,
      load: record => this.load(record), persist: () => this.persist(), view: () => this.view(),
    }, input);
  }
  close(options                               = {})                {
    this.draining ??= settleCleanup([...this.instances.values()].map(item => () => item.close()));
    if (options.retainEvidence) return this.draining;
    this.evidenceClosing ??= settleCleanup(
      () => this.draining,
      [() => this.requests.close(), () => this.runs.close(), () => this.interactions.close()],
    );
    return this.evidenceClosing;
  }
}
