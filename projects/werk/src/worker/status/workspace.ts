import type { ExecutionProfilesControl } from '../application/execution-profiles.js';
import { RepositoryDiscovery } from '../infrastructure/repository-discovery.js';
import type { RepositoryConfiguration } from '../application/repositories.js';
import { RepositoryManager, prepareRepositoryWorktree } from '../infrastructure/repositories.js';
import { requestGateSchema } from '../application/request-gate-schema.js';
import { requestDispatchStatus } from '../application/request-dispatch.js';
import { RequestReviewManager } from "../application/request-review.js";
import {
  defaultGatePolicy,
  gateFacts,
  type RequestCommand,
} from "../application/request-gates.js";
import { modelFor } from "../infrastructure/providers.js";
import { WorkerResourceMonitor } from "../application/resource-monitor.js";
import { WorkerResourceJournal } from "../infrastructure/journal/resource-events.js";
import { resourceSampler } from "../infrastructure/resource-sampler.js";
import { serviceEvent } from "../../shared/http/observability.js";
import {
  planProjectIntegrations,
  syncProjectIntegrations,
} from "../infrastructure/project-integrations.js";
import type { InteractionCommand } from "../application/interactions.js";
import { modelCapabilities } from "../application/model-contract.js";
import type { RunQuery } from "../application/run-evidence.js";
import {
  FeatureRequests,
  type FeatureRecord,
} from "../application/feature-requests.js";
import { MarkdownFeatureFolder } from "../infrastructure/features/folder.js";
import { definitionConnection } from "../application/definitions.js";
import { WorkerSettings } from "../infrastructure/settings.js";
import { WorkerSessions } from "../application/sessions.js";
import { LocalTaskboard } from "../application/local-tasks.js";
import { TaskIndex } from "../infrastructure/task-index.js";
import { object, text, identifier, type Task } from "../../shared/contracts.js";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { join, resolve, isAbsolute } from "node:path";
import { opendir, statfs, realpath, lstat } from "node:fs/promises";
import {
  availableParallelism,
  freemem,
  totalmem,
  hostname,
  release,
  loadavg,
} from "node:os";
import { DomainError } from "../../shared/errors.js";
import {
  atomicWrite,
  ensureDirectory,
  readBoundedFile,
} from "../infrastructure/journal/files.js";
import type { SnapshotJournal } from "../infrastructure/journal/snapshots.js";
import type { Status } from "./server.js";
export function chatConfiguration(value: unknown): string | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DomainError("invalid_input", "chat must contain codexExecutable");
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).length !== 1 ||
    typeof raw.codexExecutable !== "string" ||
    !isAbsolute(raw.codexExecutable) ||
    raw.codexExecutable.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(raw.codexExecutable)
  )
    throw new DomainError(
      "invalid_input",
      "chat.codexExecutable must be an absolute path",
    );
  if (process.platform !== "linux")
    throw new DomainError(
      "invalid_input",
      "Codex chat currently requires native Linux",
    );
  return raw.codexExecutable;
}
export class WorkerWorkspace {
  readonly executionProfiles?: ExecutionProfilesControl;
  private taskIndex: TaskIndex;
  readonly features?: FeatureRequests;
  readonly repositories: RepositoryManager;
  readonly repositoryDiscovery: RepositoryDiscovery;
  private configurationUpdating = false;
  private repositoryPreparations = 0;
  private repositoriesUpdating = false;
  private repositoryStop = new AbortController();
  readonly resources: WorkerResourceMonitor;
  readonly reviews: RequestReviewManager;
  readonly settings: WorkerSettings;
  readonly sessions: WorkerSessions;
  readonly board: LocalTaskboard;
  get accessScope() {
    return createHash("sha256").update(this.token).digest("hex").slice(0, 16);
  }
  get definitions() {
    return this.sessions.definitions;
  }
  get chat() {
    return this.sessions.chat;
  }
  get executor() {
    return this.sessions.executor;
  }
  async taskboardAction(input: unknown) {
    if ((input as Record<string, unknown> | null)?.action === 'retry')
      return this.withRepositoryAdmission(() => this.board.action(input));
    return this.board.action(input);
  }
  async startChat(message: unknown) {
    if (this.configurationUpdating || this.executionProfiles?.pending())
      throw new DomainError("conflict", "Finish the execution profile change before starting new work.");
    if (!this.acceptingTasks)
      throw new DomainError("unavailable", "Worker is stopping.");
    if (
      this.sessions.chatActive + this.board.active >=
      this.settings.value.board.queueCapacity
    )
      throw new DomainError("conflict", "Worker task queue is full.");
    return this.sessions.start(message);
  }
  capabilities() {
    return {
      schemaVersion: 1,
      scope: "worker_local_model_wrapper",
      interactionProtocol: 1,
      requests: {
        schemaVersion: 1,
        deterministicGates: true,
        policyFormat: "bounded_json_rules",
        stages: ["ready", "done"],
        rework: ["operator", "llm"],
        events: "polling",
        scope: "this_worker_accepted_requests",
        mergeAuthority: false,
      },
      events: { transport: "polling", streaming: false },
      capabilities: modelCapabilities,
      resources: {
        supported: true,
        scope: "worker_node_process",
        events: "polling",
        sampleIntervalMs: 10000,
        automaticActions: false,
      },
      repositories: { supported: true, synchronization: "fetch_fast_forward_only", workspaces: "git_worktrees", publication: false },
      projectIntegrations: {
        supported: true,
        enabled: !!(
          this.config.integrationProjectDir ?? this.config.projectDir
        ),
        inspection: "read_only",
        synchronization: "expected_plan",
        automaticExecution: false,
      },
    };
  }
  async requestCommand(input: unknown) {
    const initial = object(input, "Request command", [
      "action",
      "sessionId",
      "requestId",
      "limit",
      "offset",
      "after",
      "expectedRevision",
      "operationId",
      "policy",
      "stage",
      "assignee",
      "note",
      "findingId",
      "input",
      "candidateId",
      "inputHash",
      "outputDigest",
    ]);
    const action = String(initial.action);
    const reads: Record<string, string[]> = {
      list: ["action", "sessionId", "limit", "offset"],
      get: ["action", "requestId"],
      events: ["action", "requestId", "after", "limit"],
      schema: ["action"],
      policy: ["action"],
      set_policy: ["action", "policy", "expectedRevision", "operationId"],
      execute: ["action", "requestId", "expectedRevision", "operationId"],
    };
    if (
      reads[action] &&
      Object.keys(initial).some((key) => !reads[action]!.includes(key))
    )
      throw new DomainError(
        "invalid_input",
        "Use the documented fields for this request action.",
      );
    const gates = this.sessions.requests;
    if (action === "schema")
      return {
        schemaVersion: 1,
        jsonSchema: requestGateSchema,
        facts: gateFacts,
        operators: ["eq", "neq", "gte", "lte"],
        stages: ["ready", "done"],
        defaultPolicy: defaultGatePolicy(),
        unknown: "fails_closed",
        operatorAttestation:
          "explicit_operator_decision_not_proof_of_human_identity",
      };
    if (action === "policy") return gates.policy();
    if (action === "list")
      return gates.list({
        sessionId: initial.sessionId as string | undefined,
        limit: initial.limit as number | undefined,
        offset: initial.offset as number | undefined,
      });
    if (action === "get")
      return gates.get(identifier(initial.requestId, "requestId"));
    if (action === "events")
      return gates.events(
        identifier(initial.requestId, "requestId"),
        initial.after as number | undefined,
        initial.limit as number | undefined,
      );
    if (!this.acceptingTasks)
      throw new DomainError("unavailable", "Worker is stopping.");
    if (action !== "cancel" && (this.configurationUpdating || this.executionProfiles?.pending()))
      throw new DomainError("conflict", "Finish the execution profile change before starting new work.");
    if (action === "set_policy")
      return gates.setPolicy({
        policy: initial.policy,
        expectedRevision: initial.expectedRevision as number,
        operationId: initial.operationId as string,
      });
    const requestId = identifier(initial.requestId, "requestId");
    const before = gates.get(requestId);
    if (
      before.owner.remote &&
      ["propose", "accept_candidate", "execute"].includes(action)
    )
      throw new DomainError(
        "conflict",
        "Remote assignments require an explicit upstream successor with a fresh lease and pinned context.",
      );
    const result = gates.command(initial as unknown as RequestCommand);
    if (!result.duplicate && action === "cancel")
      this.reviews.cancel(requestId);
    if (
      !result.duplicate &&
      (action === "execute" || action === "accept_candidate")
    ) {
      const current = gates.get(requestId);
      if (current.phase === "ready") {
        try {
          if (current.input.kind === "patch") await this.board.executeRequest(requestId);
          else await this.sessions.executeRequest(requestId);
        } catch (error) {
          const code = error instanceof DomainError ? error.code : 'unavailable';
          const explanation = error instanceof DomainError ? error.message + ' ' : '';
          throw new DomainError(code, explanation + 'The request command was saved, but dispatch did not finish. Read the current request; if this input remains ready, issue a new guarded execute with a new operation ID.');
        }
      }
    }
    this.reviews.tick();
    const request = gates.get(requestId);
    return { ...result, request, dispatch: requestDispatchStatus(request, action) };
  }
  resourceEvents(input: unknown) {
    const body = object(input, "Resource query", ["action", "after", "limit"]);
    if (body.action !== "events")
      throw new DomainError("invalid_input", "Use the resource events action.");
    return this.resources.events(
      body.after as number | undefined,
      body.limit as number | undefined,
    );
  }
  async integrations(input: unknown = { action: "status" }) {
    const body = object(input, "Project integration command", [
      "action",
      "expectedPlan",
    ]);
    if (
      !["status", "plan", "apply"].includes(String(body.action)) ||
      (body.action !== "apply" && body.expectedPlan !== undefined)
    )
      throw new DomainError(
        "invalid_input",
        "Use status, plan or apply with the documented fields.",
      );
    const projectDirectory =
      this.config.integrationProjectDir ?? this.config.projectDir;
    if (!projectDirectory) {
      if (body.action === "apply")
        throw new DomainError(
          "conflict",
          "Start an installed project worker or configure its project directory before synchronizing integrations.",
        );
      return {
        schemaVersion: 1 as const,
        enabled: false as const,
        reason: "Project integrations require a configured project directory.",
      };
    }
    if (body.action === "apply") {
      if (
        typeof body.expectedPlan !== "string" ||
        !/^[a-f0-9]{64}$/.test(body.expectedPlan)
      )
        throw new DomainError(
          "invalid_input",
          "Apply requires the current 64-character expectedPlan identifier.",
        );
      return {
        ...(await syncProjectIntegrations(projectDirectory, body.expectedPlan)),
        enabled: true as const,
      };
    }
    return {
      ...(await planProjectIntegrations(projectDirectory)),
      enabled: true as const,
    };
  }
  async interaction(input: unknown) {
    const body = object(input, "Interaction command", [
      "action",
      "sessionId",
      "turnId",
      "pendingId",
      "expectedRevision",
      "operationId",
      "answer",
      "message",
      "after",
      "limit",
    ]);
    const allowed: Record<string, string[]> = {
      get: ["action", "sessionId"],
      turn: ["action", "sessionId", "turnId"],
      events: ["action", "sessionId", "after", "limit"],
      answer: [
        "action",
        "sessionId",
        "pendingId",
        "expectedRevision",
        "operationId",
        "answer",
      ],
      resume: [
        "action",
        "sessionId",
        "turnId",
        "expectedRevision",
        "operationId",
        "message",
      ],
      cancel: [
        "action",
        "sessionId",
        "pendingId",
        "expectedRevision",
        "operationId",
      ],
    };
    if (
      !allowed[String(body.action)] ||
      Object.keys(body).some(
        (key) => !allowed[String(body.action)]!.includes(key),
      )
    )
      throw new DomainError(
        "invalid_input",
        "Use the documented fields for this interaction action.",
      );
    const sessionId = identifier(body.sessionId, "sessionId");
    const detail = this.sessions.detail(sessionId);
    if (body.action === "get")
      return this.sessions.interactions.view(sessionId);
    if (body.action === "events")
      return this.sessions.interactions.events(
        sessionId,
        body.after as number | undefined,
        body.limit as number | undefined,
      );
    if (body.action === "turn")
      return this.sessions.interactions.turn(
        sessionId,
        identifier(body.turnId, "turnId"),
      );
    if (body.action === "cancel") {
      if (
        !Number.isSafeInteger(body.expectedRevision) ||
        Number(body.expectedRevision) < 0
      )
        throw new DomainError(
          "invalid_input",
          "Provide the current interaction revision.",
        );
      this.sessions.interactions.abandon(
        sessionId,
        Number(body.expectedRevision),
        identifier(body.operationId, "operationId"),
        identifier(body.pendingId, "pendingId"),
      );
      const current = this.sessions.interactions.view(sessionId);
      const local = this.board
        .view()
        .tasks.find((task) => task.sessionId === sessionId);
      if (
        current.phase === "cancelled" &&
        local &&
        ["waiting_input", "escalated"].includes(local.status)
      )
        await this.board.action(
          { id: local.id, action: "cancel" },
          current.revision,
        );
      return this.sessions.interactions.view(sessionId);
    }
    if (!["answer", "resume"].includes(String(body.action)))
      throw new DomainError(
        "invalid_input",
        "Interaction action: get|turn|answer|resume|cancel",
      );
    if (this.configurationUpdating || this.executionProfiles?.pending())
      throw new DomainError("conflict", "Finish the execution profile change before starting new work.");
    if (!this.acceptingTasks)
      throw new DomainError("unavailable", "Worker is stopping.");
    if (
      !Number.isSafeInteger(body.expectedRevision) ||
      Number(body.expectedRevision) < 0
    )
      throw new DomainError(
        "invalid_input",
        "Provide the current interaction revision.",
      );
    identifier(body.operationId, "operationId");
    if (body.action === "answer") {
      identifier(body.pendingId, "pendingId");
      text(body.answer, "Answer", 8000);
    }
    if (body.action === "resume") {
      identifier(body.turnId, "turnId");
      if (body.message !== undefined) text(body.message, "Continuation", 8000);
    }
    const command = body as unknown as InteractionCommand;
    const interactions = this.sessions.interactions;
    const view = interactions.view(sessionId);
    const acknowledged = interactions.operation(sessionId, command.operationId);
    const targetId =
      command.action === "resume"
        ? command.turnId
        : (view.pending?.turnId ?? view.latestTurn?.id);
    const target =
      acknowledged ??
      (targetId ? interactions.turn(sessionId, targetId) : undefined);
    const context = target?.context as
      | { taskId?: unknown; chatMessages?: unknown }
      | null
      | undefined;
    const operation =
      target?.dispatch?.operation ??
      (Array.isArray(context?.chatMessages)
        ? "chat"
        : typeof context?.taskId === "string"
          ? "patch"
          : undefined);
    const local = this.board
      .view()
      .tasks.find((task) => task.sessionId === sessionId);
    if (
      detail.session.kind === "local" &&
      local &&
      operation === "patch" &&
      context?.taskId === local.id
    )
      return this.board.interact(command);
    return this.sessions.interact(command);
  }
  runEvidence(input: unknown) {
    const body = object(input, "Run evidence query", [
      "action",
      "id",
      "sessionId",
      "taskId",
      "provider",
      "kind",
      "purpose",
      "outcome",
      "since",
      "until",
      "limit",
      "offset",
      "cursor",
      "asOf",
    ]);
    const { action, id, ...query } = body;
    if (action === "get") return this.sessions.runs.get(String(id ?? ""));
    if (id !== undefined)
      throw new DomainError("invalid_input", "A run ID is only used with get.");
    if (action === "list" || action === "export")
      return this.sessions.runs.list(query as RunQuery);
    if (action === "analyze")
      return this.sessions.runs.analyze(query as RunQuery);
    throw new DomainError(
      "invalid_input",
      "Run action: list|get|analyze|export",
    );
  }
  private taskRequests = Promise.resolve();
  private acceptingTasks = true;
  /** Address sessions directly; automation never changes the browser's selected task. */
  async task(input: unknown) {
    const operation = this.taskRequests
      .catch(() => {})
      .then(async () => {
        if (!this.acceptingTasks)
          throw new DomainError("unavailable", "Worker is stopping.");
        const body = object(input, "Task command", [
          "action",
          "id",
          "title",
          "provider",
          "message",
          "definitionId",
          "agent",
          "useInstructionsOnly",
        ]);
        if (
          !["create", "get", "send", "cancel", "retry"].includes(
            String(body.action),
          )
        )
          throw new DomainError(
            "invalid_input",
            "Task action: create|get|send|cancel|retry",
          );
        if (
          body.action !== "create" &&
          (body.definitionId !== undefined ||
            body.agent !== undefined ||
            body.useInstructionsOnly !== undefined)
        )
          throw new DomainError(
            "invalid_input",
            "An agent definition is fixed when a task is created.",
          );
        const id =
          body.action === "create" && body.id === undefined
            ? randomUUID()
            : identifier(body.id, "id");
        if (body.action === "get") return this.sessions.detail(id);
        if (body.action === "cancel") return this.sessions.cancelTask(id);
        if (this.configurationUpdating || this.executionProfiles?.pending())
          throw new DomainError("conflict", "Finish the execution profile change before starting new work.");
        let requestMessage = body.message;
        if (body.action === "retry") {
          const detail = this.sessions.detail(id);
          if (
            detail.session.kind !== "chat" ||
            !["failed", "cancelled"].includes(detail.session.status) ||
            detail.session.busy
          )
            throw new DomainError(
              "conflict",
              "Only failed or cancelled chat tasks can be retried. Use the owning taskboard or orchestrator for assignments.",
            );
          requestMessage = detail.chat.messages
            .filter((item) => item.role === "user")
            .at(-1)?.text;
        }
        const message = text(requestMessage, "message", 8000);
        if (body.action === "create") {
          const title = text(body.title, "title", 120),
            provider = this.settings.provider(String(body.provider));
          const existing = this.sessions
            .view()
            .records.find((item) => item.id === id);
          const savedDefinition = existing?.definition;
          const definition =
            savedDefinition &&
            body.definitionId === savedDefinition.definitionId &&
            (body.agent ?? "root") === savedDefinition.agent &&
            (!savedDefinition.adapted || body.useInstructionsOnly === true)
              ? savedDefinition
              : this.definitions.select(body);
          definitionConnection(provider, definition);
          const submissionHash = createHash("sha256")
            .update(
              JSON.stringify({
                title,
                provider: provider.id,
                message,
                ...(definition ? { definition } : {}),
              }),
            )
            .digest("hex");
          if (existing) {
            const detail = this.sessions.detail(id);
            if (
              existing.kind !== "chat" ||
              existing.submissionHash !== submissionHash
            )
              throw new DomainError(
                "conflict",
                "Task id already belongs to different input.",
              );
            if (detail.chat.messages.length > 0) return detail;
          }
          if (
            this.sessions.chatActive + this.board.active >=
            this.settings.value.board.queueCapacity
          )
            throw new DomainError("conflict", "Worker task queue is full.");
          await this.withRepositoryAdmission(() => this.sessions.ensureTask(
            id,
            "chat",
            title,
            provider.id,
            submissionHash,
            definition,
          ));
        }
        if (
          this.sessions.chatActive + this.board.active >=
          this.settings.value.board.queueCapacity
        )
          throw new DomainError("conflict", "Worker task queue is full.");
        await this.withRepositoryAdmission(() => this.sessions.start(message, id));
        return this.sessions.detail(id);
      });
    this.taskRequests = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
  private token = "";
  private historyCache?: {
    at: number;
    value: Awaited<ReturnType<WorkerWorkspace["readHistory"]>>;
  };
  private historyReading?: ReturnType<WorkerWorkspace["readHistory"]>;
  private config: {
    executionProfiles?: ExecutionProfilesControl;
    stateDir: string;
    url?: string;
    enrollmentToken?: string;
    projectDir?: string;
    integrationProjectDir?: string;
    codex?: { repository?: string };
    repositories?: RepositoryConfiguration;
    features?: { directory: string; provider: string; pollMs: number };
    chatExecutable?: string;
    retainedPairs?: number;
    pollMs: number;
    timeoutMs: number;
  };
  private journal: SnapshotJournal;
  private get: () => Status;
  constructor(
    config: {
      executionProfiles?: ExecutionProfilesControl;
      stateDir: string;
      url?: string;
      enrollmentToken?: string;
      projectDir?: string;
      integrationProjectDir?: string;
      codex?: { repository?: string };
      repositories?: RepositoryConfiguration;
      features?: { directory: string; provider: string; pollMs: number };
      chatExecutable?: string;
      retainedPairs?: number;
      pollMs: number;
      timeoutMs: number;
    },
    journal: SnapshotJournal,
    get: () => Status,
  ) {
    this.taskIndex = new TaskIndex(config.stateDir);
    this.config = config;
    this.executionProfiles = config.executionProfiles;
    this.journal = journal;
    this.get = get;
    this.settings = new WorkerSettings(
      config.stateDir,
      config.url,
      config.enrollmentToken,
      config.chatExecutable,
      config.repositories,
    );
    this.repositories = new RepositoryManager(this.settings.value.repositories, { beforeRepositoryUse: item => this.repositoryDiscovery.assertAllowed(item.path) });
    this.repositoryDiscovery = new RepositoryDiscovery(config.stateDir, config.integrationProjectDir ?? config.projectDir ?? process.cwd(), this.repositoryStop.signal, config.codex?.repository);
    this.sessions = new WorkerSessions(
      config.stateDir, this.settings, modelFor, undefined, () => this.board.active,
    );
    this.board = new LocalTaskboard(
      config.stateDir,
      this.settings,
      this.sessions,
      { prepareWorktree: (selector, key, signal, commit) => this.prepareTaskWorkspace(selector, key, signal, commit) },
    );
    this.reviews = new RequestReviewManager({
      gates: this.sessions.requests,
      executor: this.executor,
      runs: this.sessions.runs,
      maxRuntimeMs: () => this.settings.value.execution.maxRuntimeMs,
      model: (profile) =>
        modelFor(
          {
            ...this.settings.provider(profile.id),
            model: profile.model,
            instruction: profile.instruction,
          },
          config.stateDir,
        ),
    });
    this.sessions.onRequestChanged = (id) => {
      if (this.sessions.requests.get(id).phase === "cancelled")
        this.reviews.cancel(id);
      this.reviews.tick();
    };
    this.resources = new WorkerResourceMonitor({
      store: new WorkerResourceJournal(config.stateDir),
      read: resourceSampler(config.stateDir),
      policy: () => this.settings.value.resources,
      active: () =>
        this.executor.current &&
        this.executor.startedAt !== null &&
        this.executor.startedMonotonicAt !== null
          ? {
              sessionId: this.executor.current,
              startedAt: this.executor.startedAt,
              monotonicStartedAt: this.executor.startedMonotonicAt,
            }
          : null,
      log: (event) =>
        serviceEvent(
          "worker",
          event,
          event === "resource_alert_resolved" ? "info" : "warn",
        ),
    });
    if (config.features)
      this.features = new FeatureRequests(
        new MarkdownFeatureFolder(
          config.features.directory,
          config.stateDir,
          config.features.provider,
          config.projectDir ?? process.cwd(),
        ),
        {
          submit: (record) => this.submitFeature(record),
          inspect: (record) => this.inspectFeature(record),
          control: (record, action) =>
            record.input?.mode === "patch"
              ? this.taskboardAction({ id: record.taskId, action })
              : this.task({ id: record.sessionId, action }),
        },
        config.features.pollMs,
      );
  }
  async init() {
    await ensureDirectory(this.config.stateDir);
    try {
      this.token = (
        await readBoundedFile(join(this.config.stateDir, "webview-token"), 128)
      ).trim();
      if (!/^[a-f0-9]{64}$/.test(this.token))
        throw Error("Invalid worker webview token");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.token = randomBytes(32).toString("hex");
      await atomicWrite(
        join(this.config.stateDir, "webview-token"),
        this.token + "\n",
      );
    }
    await this.settings.init();
    await this.repositoryDiscovery.init(this.settings.value.repositories.items);
    await this.repositories.configure(this.settings.value.repositories);
    await this.repositories.init();
    await this.sessions.init();
    await this.board.init();
    await this.taskIndex.init();
    await this.features?.init();
    await this.resources.init();
    this.resources.start();
    this.repositories.start();
  }
  repositoryStatus() {
    return { schemaVersion: 1, pollMs: this.settings.value.repositories.pollMs, items: this.repositories.view(), discovery: this.repositoryDiscovery.view() };
  }
  async repositoryCommand(input: unknown) {
    const body = object(input, "Repository command", ["action", "id", "discoveryId"]);
    if (body.action === "accept" || body.action === "decline") {
      if (body.id !== undefined) throw new DomainError("invalid_input", "Use discoveryId for the detected installation repository.");
      return this.chooseDiscoveredRepository(body.action, body.discoveryId);
    }
    if (body.discoveryId !== undefined) throw new DomainError("invalid_input", "Use discoveryId only when accepting or declining a detected repository.");
    if (body.action === "status" && body.id === undefined) return this.repositoryStatus();
    if (body.action !== "sync" || (body.id !== undefined && typeof body.id !== "string"))
      throw new DomainError("invalid_input", "Use status or sync with an optional repository id.");
    if (!this.acceptingTasks || this.repositoriesUpdating || this.configurationUpdating || this.executionProfiles?.pending())
      throw new DomainError("unavailable", "Worker configuration is changing or the worker is stopping.");
    if (body.id !== undefined) this.repositories.resolve(body.id as string);
    await this.repositories.sync(body.id as string | undefined);
    return this.repositoryStatus();
  }
  private assertRepositoryChangeAllowed() {
    if (!this.acceptingTasks || this.configurationUpdating || this.executionProfiles?.pending())
      throw new DomainError("unavailable", "Worker configuration is changing or the worker is stopping.");
    if (this.repositoriesUpdating || this.repositoryPreparations || this.sessions.busy || this.board.active || this.get().activeTasks.length || this.get().queuedTasks?.length)
      throw new DomainError("conflict", "Finish or cancel queued and active tasks before changing repository assignments.");
  }
  private async chooseDiscoveredRepository(action: "accept" | "decline", id: unknown) {
    if (action === "accept") this.assertRepositoryChangeAllowed();
    else if (!this.acceptingTasks || this.repositoriesUpdating || this.configurationUpdating)
      throw new DomainError("unavailable", "Worker configuration is changing or the worker is stopping.");
    this.repositoriesUpdating = true;
    try {
      await this.repositoryDiscovery.verify(id);
      await this.repositoryDiscovery.assignmentsChanged(this.settings.value.repositories.items);
      const candidate = this.repositoryDiscovery.view();
      if (!candidate || candidate.id !== id) throw new DomainError("conflict", "The installation repository changed. Refresh and review it before choosing.");
      if (action === "decline") {
        if (candidate.repositoryId && candidate.decision === "accepted") throw new DomainError("conflict", "This repository is assigned already. Remove its assignment before declining it.");
        await this.repositoryDiscovery.record("declined");
      } else {
        if (!candidate.repositoryId) {
          const configuration = this.settings.value.repositories;
          await this.settings.update({ repositories: { ...configuration, items: [...configuration.items, this.repositoryDiscovery.assignment(configuration.items)] } });
        }
        const assignment = this.settings.value.repositories.items.find(item => item.path === candidate.path || item.id === candidate.repositoryId);
        await this.repositoryDiscovery.record("accepted", assignment?.id);
        await this.repositoryDiscovery.assignmentsChanged(this.settings.value.repositories.items);
        await this.repositories.configure(this.settings.value.repositories);
      }
      return this.repositoryStatus();
    } finally { this.repositoriesUpdating = false; }
  }
  async withIdleConfiguration<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.acceptingTasks || this.configurationUpdating || !this.settings.value.board.paused || this.repositoriesUpdating || this.repositoryPreparations || this.sessions.busy || this.board.active || this.get().activeTasks.length || this.get().queuedTasks?.length)
      throw new DomainError("conflict", "Pause intake and finish or cancel queued tasks and active replies before changing execution profiles.");
    this.configurationUpdating = true;
    try { return await operation(); } finally { this.configurationUpdating = false; }
  }
  async withRepositoryAdmission<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.acceptingTasks || this.repositoriesUpdating || this.configurationUpdating || this.executionProfiles?.pending())
      throw new DomainError("unavailable", "Worker configuration is changing or the worker is stopping.");
    this.repositoryPreparations++;
    try {
      return await operation();
    } finally {
      this.repositoryPreparations--;
    }
  }
  private async prepareTaskWorkspace(selector: string, key: string, signal: AbortSignal, commit?: string) {
    if (!this.acceptingTasks || this.repositoriesUpdating || this.configurationUpdating || this.executionProfiles?.pending())
      throw new DomainError("unavailable", "Worker configuration is changing or the worker is stopping.");
    signal = AbortSignal.any([signal, this.repositoryStop.signal]);
    this.repositoryPreparations++;
    try {
      if (this.settings.value.repositories.items.length)
        return await this.repositories.prepareWorktree(selector, key, signal, commit);
      // Legacy approved-file tasks may still use an ordinary, non-Git project folder.
      if (!isAbsolute(selector)) throw new DomainError("invalid_input", "Choose an assigned repository or an absolute project folder.");
      const repository = await realpath(selector);
      await this.repositoryDiscovery.assertAllowed(repository);
      const metadata = await lstat(join(repository, ".git")).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      return metadata ? await prepareRepositoryWorktree(repository, key, signal, commit) : { repository, path: repository };
    } finally { this.repositoryPreparations--; }
  }
  async updateSettings(body: unknown) {
    const input = body as Record<string, unknown>;
    if (this.configurationUpdating || (this.executionProfiles?.pending() && (input?.board as Record<string, unknown>)?.paused === false))
      throw new DomainError("conflict", "Finish the execution profile change before updating worker settings or resuming intake.");
    const update = async () => {
      if (input?.provider && (this.sessions.busy || this.board.active))
        throw new DomainError(
          "conflict",
          "Finish or stop queued tasks and active replies before changing providers.",
        );
      if (
        input?.connection &&
        (this.get().activeTasks.length || this.get().queuedTasks?.length)
      )
        throw new DomainError(
          "conflict",
          "Pause intake and drain orchestrator assignments before changing the connection.",
        );
      if (input?.connection) {
        const connection = input.connection as Record<string, unknown>;
        try {
          const identity = JSON.parse(
            await readBoundedFile(
              join(this.config.stateDir, "identity.json"),
              16384,
            ),
          );
          if (
            connection.url &&
            new URL(String(connection.url)).origin !==
              new URL(identity.url).origin
          )
            throw new DomainError(
              "conflict",
              "This identity is bound to another orchestrator. Use a separate worker state directory for another server.",
            );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (input?.provider)
        return this.sessions.updateProviders(() => this.settings.update(body));
      return this.settings.update(body);
    };
    if (input?.repositories !== undefined) {
      this.assertRepositoryChangeAllowed();
      this.repositoriesUpdating = true;
      try {
        const result = await update();
        await this.repositoryDiscovery.assignmentsChanged(this.settings.value.repositories.items);
        await this.repositories.configure(this.settings.value.repositories);
        return result;
      } finally { this.repositoriesUpdating = false; }
    }
    return update();
  }
  async close(options: { deferEvidence?: boolean } = {}) {
    this.acceptingTasks = false;
    this.repositoryStop.abort();
    // Abort Git preparation before awaiting feature intake, which may be waiting on it.
    await Promise.all([
      this.features?.stopIntake(), this.repositories.close(), this.board.close(),
      this.reviews.close(), this.taskRequests,
    ]);
    await this.sessions.close({ retainEvidence: true });
    if (!options.deferEvidence) await this.closeEvidence();
  }
  /** Runner calls this after remote assignments have also drained their final session writes. */
  async closeEvidence() {
    try {
      await this.features?.close();
    } finally {
      try {
        await this.resources.close();
      } finally {
        this.sessions.runs.close();
        this.sessions.interactions.close();
        this.sessions.requests.close();
      }
    }
  }
  async rememberTask(task: Task) {
    await this.taskIndex.remember(task);
    await this.features?.rememberRemote(task);
    await this.sessions.ensureTask(
      "remote-" + task.id,
      "orchestrator",
      task.title,
      task.provider === "claude" ? "claude-cli" : "codex-cli",
    );
    this.historyCache = undefined;
  }
  private async submitFeature(record: FeatureRecord) {
    const input = record.input!;
    if (input.mode === "patch") {
      await this.board.create(
        {
          title: input.title,
          instruction: input.message,
          provider: input.provider,
          repository: resolve(this.config.projectDir ?? process.cwd()),
          paths: input.paths,
          priority: input.priority,
          definitionId: input.definitionId,
          agent: input.agent,
          useInstructionsOnly: input.useInstructionsOnly,
        },
        { id: record.taskId, hash: record.inputHash },
      );
    } else
      await this.task({
        action: "create",
        id: record.taskId,
        title: input.title,
        provider: input.provider,
        message: input.message,
        definitionId: input.definitionId,
        agent: input.agent,
        useInstructionsOnly: input.useInstructionsOnly,
      });
  }
  private executionEvidence(sessionId: string, runId?: string) {
    const run = runId
      ? this.sessions.runs.get(runId)
      : this.sessions.runs.latest(sessionId);
    return run?.before
      ? {
          runId: run.id,
          attempt: run.attempt,
          before: run.before,
          ...(run.after ? { after: run.after } : {}),
          usage: run.usage,
          durationMs: run.durationMs,
          queueDurationMs: run.queueDurationMs,
        }
      : undefined;
  }
  private inspectFeature(record: FeatureRecord) {
    try {
      if (record.input?.mode === "patch") {
        const task = this.board.detail(record.taskId);
        return {
          request: task.requestId
            ? this.sessions.requests.get(task.requestId)
            : undefined,
          interaction: this.sessions.interactions.view(task.sessionId),
          evidence: task.runId
            ? this.executionEvidence(task.sessionId, task.runId)
            : undefined,
          status: this.board.view().persistenceError ? "unsaved" : task.status,
          text: task.summary ?? task.error ?? undefined,
          patch: task.patch ?? undefined,
          error: task.error ?? undefined,
        };
      }
      const detail = this.sessions.detail(record.sessionId),
        reply = detail.chat.messages
          .filter((message) => message.role === "assistant")
          .at(-1);
      let text = reply?.state !== "pending" ? reply?.text : undefined;
      if (record.source === "orchestrator" && text) {
        try {
          const value = JSON.parse(text);
          if (value.execution && value.quality)
            text = JSON.stringify(
              {
                execution: value.execution,
                quality: value.quality,
                review: value.review
                  ? {
                      baseCommit: value.review.baseCommit,
                      patchSha256: value.review.patchSha256,
                      patchBytes: value.review.patchBytes,
                    }
                  : null,
                note: "Full attempt and artifact details remain in the private worker history.",
              },
              null,
              2,
            );
        } catch {
          /* Cancellation messages and follow-ups are plain text. */
        }
      }
      return {
        request: this.sessions.requests.forSession(record.sessionId),
        interaction: this.sessions.interactions.view(record.sessionId),
        evidence: this.executionEvidence(record.sessionId),
        status: detail.chat.persistenceError
          ? "unsaved"
          : detail.session.status,
        text,
        ...(reply?.state === "error" ? { error: reply.text } : {}),
      };
    } catch (error) {
      if (error instanceof DomainError && error.code === "not_found") return;
      throw error;
    }
  }
  authenticate(token: string) {
    const supplied = Buffer.from(token);
    if (
      supplied.length !== 64 ||
      !timingSafeEqual(supplied, Buffer.from(this.token))
    )
      throw new DomainError(
        "unauthorized",
        "Worker access token is incorrect.",
      );
  }
  async environment() {
    const memory = process.memoryUsage(),
      disk = await statfs(this.config.stateDir).catch(() => null);
    const connection = this.settings.value.connection;
    const address = connection.url ? new URL(connection.url) : null;
    if (address) {
      address.username = "";
      address.password = "";
      address.search = "";
      address.hash = "";
    }
    return {
      capturedAt: new Date().toISOString(),
      hostname: hostname(),
      platform: process.platform,
      osRelease: release(),
      architecture: process.arch,
      nodeVersion: process.version,
      pid: process.pid,
      uptimeSeconds: process.uptime(),
      logicalCpus: availableParallelism(),
      hostLoad: process.platform === "win32" ? null : loadavg(),
      memory: {
        processRssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        hostFreeBytes: freemem(),
        hostTotalBytes: totalmem(),
      },
      disk: disk
        ? {
            freeBytes: disk.bavail * disk.bsize,
            totalBytes: disk.blocks * disk.bsize,
          }
        : null,
      repositories: this.repositoryStatus(),
      features: this.features?.view() ?? { enabled: false },
      stateDirectory: resolve(this.config.stateDir),
      projectDirectory: this.config.projectDir
        ? resolve(this.config.projectDir)
        : null,
      orchestratorUrl: address?.toString() ?? null,
      pollMs: this.config.pollMs,
      taskTimeoutMs: this.config.timeoutMs,
      retainedPairs: this.config.retainedPairs ?? 1000,
      chat: {
        configured: this.chat.snapshot().available,
        provider: this.sessions.current.provider,
        authentication: this.sessions.current.provider.endsWith("-cli")
          ? "Host CLI sign-in; use Check sign-in to verify"
          : "Private API key; use Check connection to verify",
        timeoutSeconds: this.settings.value.execution.maxRuntimeMs / 1000,
      },
      status: this.get(),
    };
  }
  async history() {
    if (this.historyCache && Date.now() - this.historyCache.at < 5000)
      return this.historyCache.value;
    this.historyReading ??= this.readHistory()
      .then((value) => {
        this.historyCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.historyReading = undefined;
      });
    return this.historyReading;
  }
  private async readHistory() {
    const rows = [];
    let inspected = 0,
      unreadable = 0,
      limited = false;
    const active = new Set(
      this.get().activeTasks.map((task) => task.id + ":" + task.attempt),
    );
    const directory = await opendir(join(this.config.stateDir, "snapshots"));
    for await (const entry of directory) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,100}$/.test(entry.name))
        continue;
      if (inspected++ >= 1000) {
        limited = true;
        break;
      }
      try {
        const after = await this.journal.read(entry.name, "after"),
          before = await this.journal.read(entry.name, "before"),
          snapshot = after ?? before;
        if (!snapshot) continue;
        rows.push({
          title: this.taskIndex.title(snapshot.taskId),
          pairId: snapshot.pairId,
          taskId: snapshot.taskId,
          attempt: snapshot.attempt,
          project: snapshot.project,
          provider: snapshot.provider,
          profile: snapshot.profileId,
          mode: snapshot.mode,
          startedAt: before?.capturedAt ?? null,
          finishedAt: after?.capturedAt ?? null,
          outcome:
            after?.execution.outcome ??
            (active.has(snapshot.taskId + ":" + snapshot.attempt)
              ? "running"
              : "incomplete"),
          durationMs: after?.execution.durationMs ?? null,
          error: after?.execution.error ?? null,
          resources: snapshot.resources,
          usage: snapshot.usage,
          quality: snapshot.quality,
          provenance: snapshot.provenance,
          review: after?.review ?? null,
          completePair: !!before && !!after,
        });
      } catch {
        unreadable++;
      }
    }
    rows.sort(
      (a, b) =>
        (b.startedAt ?? b.finishedAt ?? "").localeCompare(
          a.startedAt ?? a.finishedAt ?? "",
        ) || a.pairId.localeCompare(b.pairId),
    );
    return {
      rows,
      limited,
      unreadable,
      capturedAt: new Date().toISOString(),
      retainedPairs: this.config.retainedPairs ?? 1000,
    };
  }
}
