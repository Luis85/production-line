import { FeatureTracking } from '../application/feature-tracking.js';
import { MarkdownFeatureTracking } from '../infrastructure/features/tracking.js';
import { WorkerConsumption } from '../application/consumption.js';
import { consumptionModel } from '../application/consumption-model.js';
import { WorkerConsumptionJournal } from '../infrastructure/journal/consumption.js';
import { ProviderStatusChecks } from '../infrastructure/provider-status.js';
import { createWorkerSessions, createLocalTaskboard } from '../infrastructure/workspace-services.js';
import { ProviderAccountChecks } from '../infrastructure/provider-account.js';
import { SharedIntakeRuntime } from '../infrastructure/features/shared-intake-runtime.js';
import type { ExecutionProfilesControl } from '../application/execution-profiles.js';
import { RepositoryDiscovery } from '../infrastructure/repository-discovery.js';
import type { RepositoryConfiguration } from '../application/repositories.js';
import { RepositoryManager } from '../infrastructure/repositories.js';
import { RequestReviewManager } from "../application/request-review.js";
import { modelFor } from "../infrastructure/providers.js";
import { WorkerResourceMonitor } from "../application/resource-monitor.js";
import { WorkerResourceJournal } from "../infrastructure/journal/resource-events.js";
import { resourceSampler } from "../infrastructure/resource-sampler.js";
import { serviceEvent } from "../../shared/http/observability.js";
import { FeatureRequests } from "../application/feature-requests.js";
import { MarkdownFeatureFolder } from "../infrastructure/features/folder.js";
import { definitionConnection } from "../application/definitions.js";
import { WorkerSettings } from "../infrastructure/settings.js";
import type { WorkerSessions } from "../application/sessions.js";
import type { LocalTaskboard } from "../application/local-tasks.js";
import { TaskIndex } from "../infrastructure/task-index.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { SnapshotJournal } from "../infrastructure/journal/snapshots.js";
import type { Status } from "./server.js";
import { task } from './workspace-tasks.js';
import { taskboardAction } from './workspace-task-views.js';
import { featureTrackingSnapshot, inspectSharedFeature, submitSharedFeature, submitFeature, inspectFeature } from './workspace-features.js';
import { prepareTaskWorkspace, removeTaskWorkspace } from './workspace-repositories.js';
import type { readHistory } from './workspace-environment.js';

export interface WorkspaceConfiguration {
    executionProfiles?: ExecutionProfilesControl;
    stateDir: string;
    url?: string;
    enrollmentToken?: string;
    webviewToken?: string;
    projectDir?: string;
    integrationProjectDir?: string;
    codex?: { repository?: string };
    repositories?: RepositoryConfiguration;
    features?: { directory: string; provider: string; pollMs: number };
    chatExecutable?: string;
    retainedPairs?: number;
    pollMs: number;
    timeoutMs: number;
  }

/** Composition-owned services and coordination state; command modules retain their own policies. */
export class WorkspaceContext {
  readonly executionProfiles?: ExecutionProfilesControl;
  taskIndex: TaskIndex;
  readonly features?: FeatureRequests;
  readonly featureTracking: FeatureTracking;
  readonly sharedRuntime: SharedIntakeRuntime;
  providerAccounts = new ProviderAccountChecks();
  providerStatuses = new ProviderStatusChecks();
  readonly repositories: RepositoryManager;
  readonly repositoryDiscovery: RepositoryDiscovery;
  configurationUpdating = false;
  repositoryPreparations = 0;
  repositoriesUpdating = false;
  repositoryStop = new AbortController();
  readonly resources: WorkerResourceMonitor;
  readonly consumption: WorkerConsumption;
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
  taskRequests = Promise.resolve();
  acceptingTasks = true;
  draining?: Promise<void>;
  closing?: Promise<void>;
  evidenceClosing?: Promise<void>;
  token = "";
  historyCache?: {
    at: number;
    value: Awaited<ReturnType<typeof readHistory>>;
  };
  historyReading?: ReturnType<typeof readHistory>;
  config: WorkspaceConfiguration;
  journal: SnapshotJournal;
  get: () => Status;
  constructor(
    config: WorkspaceConfiguration,
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
    this.consumption = new WorkerConsumption(new WorkerConsumptionJournal(config.stateDir), () => this.settings.value.consumption);
    this.repositories = new RepositoryManager(this.settings.value.repositories, { beforeRepositoryUse: item => this.repositoryDiscovery.assertAllowed(item.path), preserveCheckout: item => this.sharedRuntime?.intake.binding?.repositoryId === item.id || (this.sharedRuntime?.intake.requiredRepositoryIds().includes(item.id) ?? false) });
    this.repositoryDiscovery = new RepositoryDiscovery(config.stateDir, config.integrationProjectDir ?? config.projectDir ?? process.cwd(), this.repositoryStop.signal, config.codex?.repository);
    this.sessions = createWorkerSessions(
      config.stateDir, this.settings, modelFor, undefined, () => this.board.active, this.consumption,
      { remote: () => { const status = this.get(); return { waiting: status.queuedTasks?.length ?? null, running: status.activeTasks.length }; } },
    );
    this.board = createLocalTaskboard(
      config.stateDir,
      this.settings,
      this.sessions,
      {
        prepareWorktree: (selector, key, signal, commit) => prepareTaskWorkspace(this, selector, key, signal, commit),
        verifyWorktree: (selector, key, signal, commit) => prepareTaskWorkspace(this, selector, key, signal, commit, true),
        removeWorktree: (selector, key, signal, expected) => removeTaskWorkspace(this, selector, key, signal, expected),
      },
      undefined, this.consumption,
    );
    this.featureTracking = new FeatureTracking(new MarkdownFeatureTracking(
      config.features ? join(config.features.directory, '_tasks') : join(config.stateDir, 'feature-requests'), config.stateDir,
    ), () => featureTrackingSnapshot(this));
    this.sessions.featureTracking = this.featureTracking;
    this.reviews = new RequestReviewManager({
      gates: this.sessions.requests,
      executor: this.executor,
      runs: this.sessions.runs,
      maxRuntimeMs: () => this.settings.value.execution.maxRuntimeMs,
      model: (profile) =>
        consumptionModel(modelFor(
          {
            ...this.settings.provider(profile.id),
            model: profile.model,
            instruction: profile.instruction,
          },
          config.stateDir,
        ), this.consumption),
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
    this.sharedRuntime = new SharedIntakeRuntime({
      stateDirectory: config.stateDir,
      resolve: id => this.repositories.resolve(id),
      allowed: path => this.repositoryDiscovery.assertAllowed(path),
      canAdmit: () => this.acceptingTasks && !this.settings.value.board.paused && !this.consumption.status().blocked && !this.configurationUpdating && !this.repositoriesUpdating && !this.executionProfiles?.pending(),
      submit: record => submitSharedFeature(this, record),
      admissionIssue: input => {
        try { definitionConnection(this.settings.provider(input.provider), this.definitions.select({ definitionId: input.definitionId, definitionRef: input.definitionRef, agent: input.agent, useInstructionsOnly: input.useInstructionsOnly })); return undefined; }
        catch (error) { return error instanceof Error ? error.message : 'The selected agent definition is unavailable.'; }
      },
      inspect: id => inspectSharedFeature(this, id),
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
          submit: (record) => submitFeature(this, record),
          inspect: (record) => inspectFeature(this, record),
          control: (record, action) =>
            record.input?.mode === "patch"
              ? taskboardAction(this, { id: record.taskId, action })
              : task(this, { id: record.sessionId, action }),
        },
        config.features.pollMs,
        () => !this.sharedRuntime.intake.binding?.repositoryId,
      );
  }
}
