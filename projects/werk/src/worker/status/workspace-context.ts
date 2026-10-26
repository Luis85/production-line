import { assertManagedProjectIsolation } from './workspace-managed-isolation.js';
import { canonicalStateDirectory } from '../infrastructure/state-directory.js';
import { assertNativeWorkReady } from './workspace-native-work.js';
import { readyReviewProfile } from '../application/ready-review-selection.js';
import { authorizeDeliveryPolicy, authorizeIsolatedDeliveryPolicy, authorizeTaskDelivery } from './workspace-delivery-policy.js';
import type { SharedFeatureIntake } from '../application/shared-feature-intake.js';
import { DeliveryPolicyApprovals } from '../infrastructure/delivery-policy-approvals.js';
import { WorkspaceProjectIntakes } from './workspace-projects.js';
import { createProjectFeatureRuntime } from './workspace-project-features.js';
import { DomainError } from '../../shared/errors.js';
import { ReadyReviewManager } from '../application/ready-review.js';
import { readyReviewModels } from '../infrastructure/ready-review-model.js';
import type { ProcessSupervisor } from '../application/process-supervisor.js';
import { createProcessObservation } from '../infrastructure/process-observation.js';
import { FeatureTracking } from '../application/feature-tracking.js';
import { MarkdownFeatureTracking } from '../infrastructure/features/tracking.js';
import { WorkerConsumption } from '../application/consumption.js';
import { consumptionModel } from '../application/consumption-model.js';
import { WorkerConsumptionJournal } from '../infrastructure/journal/consumption.js';
import { ProviderStatusChecks } from '../infrastructure/provider-status.js';
import { createWorkerSessions, createLocalTaskboard } from '../infrastructure/workspace-services.js';
import { ProviderAccountChecks } from '../infrastructure/provider-account.js';
import type { SharedIntakeRuntime } from '../infrastructure/features/shared-intake-runtime.js';
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
import type { FeatureRequests } from "../application/feature-requests.js";
import { WorkerSettings } from "../infrastructure/settings.js";
import type { WorkerSessions } from "../application/sessions.js";
import type { LocalTaskboard } from "../application/local-tasks.js";
import { TaskIndex } from "../infrastructure/task-index.js";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { SnapshotJournal } from "../infrastructure/journal/snapshots.js";
import type { Status } from "./server.js";
import { sharedFeatureAdmissionHold } from './workspace-feature-admission.js';
import { featureTrackingSnapshot } from './workspace-features.js';
import { prepareTaskWorkspace, removeTaskWorkspace } from './workspace-repositories.js';
import type { readHistory } from './workspace-environment.js';

export interface WorkspaceConfiguration {
    executionProfiles?: ExecutionProfilesControl;
    stateDir: string;
    /** Authoritative launcher-selected Home, independent of an explicitly customized state directory. */
    homeDir?: string;
    url?: string;
    enrollmentToken?: string;
    webviewToken?: string;
    projectDir?: string;
    integrationProjectDir?: string;
    codex?: { repository?: string };
    repositories?: RepositoryConfiguration;
    features?: { directory: string; provider: string; pollMs: number; intake?: 'shared' | 'local' };
    chatExecutable?: string;
    retainedPairs?: number;
    pollMs: number;
    timeoutMs: number;
  }

/** Composition-owned services and coordination state; command modules retain their own policies. */
export class WorkspaceContext {
  readonly executionProfiles?: ExecutionProfilesControl;
  readonly deliveryApprovals: DeliveryPolicyApprovals;
  readonly featureProjects: WorkspaceProjectIntakes;
  taskIndex: TaskIndex;
  get features(): FeatureRequests | undefined { return this.featureProjects.primary.features; }
  readonly featureTracking: FeatureTracking;
  readonly sharedRuntime: SharedIntakeRuntime;
  providerAccounts = new ProviderAccountChecks();
  providerStatuses = new ProviderStatusChecks();
  readonly repositories: RepositoryManager;
  readonly repositoryDiscovery: RepositoryDiscovery;
  configurationUpdating = false;
  repositoryPreparations = 0;
  repositoriesUpdating = false;
  nativeWorkState: 'preparing' | 'starting' | 'ready' = 'ready';
  releaseNativeWork?: () => void;
  repositoryStop = new AbortController();
  readonly resources: WorkerResourceMonitor;
  processes?: ProcessSupervisor;
  readonly processObservations = createProcessObservation();
  processReconciliation?: ReturnType<typeof setInterval>;
  readonly consumption: WorkerConsumption;
  readonly reviews: RequestReviewManager;
  readonly readyReviews: ReadyReviewManager;
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
    if (config.homeDir !== undefined && !isAbsolute(config.homeDir)) throw new DomainError('invalid_input', 'Werk Home must be an absolute launcher-selected directory.');
    config = { ...config, stateDir: canonicalStateDirectory(config.stateDir), ...(config.homeDir ? { homeDir: canonicalStateDirectory(config.homeDir) } : {}) };
    this.taskIndex = new TaskIndex(config.stateDir);
    this.config = config;
    this.executionProfiles = config.executionProfiles;
    this.deliveryApprovals = new DeliveryPolicyApprovals(config.stateDir);
    this.journal = journal;
    this.get = get;
    this.settings = new WorkerSettings(
      config.stateDir,
      config.url,
      config.enrollmentToken,
      config.chatExecutable,
      config.repositories,
      config.features?.provider,
    );
    this.consumption = new WorkerConsumption(new WorkerConsumptionJournal(config.stateDir), () => this.settings.value.consumption);
    this.repositories = new RepositoryManager(this.settings.value.repositories, { beforeRepositoryUse: async item => { if (this.nativeWorkState === 'preparing') assertNativeWorkReady(this); await assertManagedProjectIsolation(this, item.id, item.path, { allowPendingAttachment: true }); return this.repositoryDiscovery.assertAllowed(item.path); }, preserveCheckout: item => this.featureProjects?.preservesCheckout(item) ?? false });
    this.repositoryDiscovery = new RepositoryDiscovery(config.stateDir, config.integrationProjectDir ?? config.projectDir ?? process.cwd(), this.repositoryStop.signal, config.codex?.repository, config.features?.intake === 'local' ? false : undefined);
    this.sessions = createWorkerSessions(
      config.stateDir, this.settings, modelFor, undefined, () => this.board.active, this.consumption,
      { remote: () => { const status = this.get(); return { waiting: status.queuedTasks?.length ?? null, running: status.activeTasks.length }; } },
      { supervisor: () => this.processes, observations: this.processObservations },
      { active: () => this.readyReviews?.active ?? 0, retainedSessionIds: () => this.featureProjects?.all().flatMap(project => { const intake: SharedFeatureIntake = project.sharedRuntime.intake; return intake.readyReviewSessionIds(); }) ?? [] },
    );
    this.sessions.featureSource = record => {
      const shared = record.kind === 'local' && record.id.startsWith('local-')
        ? this.featureProjects?.sharedForTask(record.id.slice(6), record.feature?.key)?.reference : undefined;
      return shared ?? this.featureProjects?.forSession(record.id, record.feature?.key)?.reference;
    };
    this.board = createLocalTaskboard(
      config.stateDir,
      this.settings,
      this.sessions,
      {
        prepareWorktree: (selector, key, signal, commit, inspection) => prepareTaskWorkspace(this, selector, key, signal, commit, false, inspection),
        verifyWorktree: (selector, key, signal, commit, inspection) => prepareTaskWorkspace(this, selector, key, signal, commit, true, inspection),
        removeWorktree: (selector, key, signal, expected) => removeTaskWorkspace(this, selector, key, signal, expected),
      },
      undefined, this.consumption, { supervisor: () => this.processes, observations: this.processObservations },
      task => authorizeTaskDelivery(this, task),
    );
    this.featureTracking = new FeatureTracking(new MarkdownFeatureTracking(
      config.features ? join(config.features.directory, '_tasks') : join(config.stateDir, 'feature-requests'), config.stateDir,
    ), () => featureTrackingSnapshot(this));
    this.sessions.featureTracking = this.featureTracking;
    this.reviews = new RequestReviewManager({
      onReady: async id => {
        const request = this.sessions.requests.get(id);
        if (request.input.kind === 'patch') await this.board.executeRequest(id);
        else await this.sessions.executeRequest(id);
      },
      gates: this.sessions.requests,
      executor: this.executor,
      runs: this.sessions.runs,
      maxRuntimeMs: () => this.settings.value.execution.maxRuntimeMs,
      model: (profile) =>
        consumptionModel(modelFor(
          {
            ...this.settings.provider(profile.id),
            model: profile.model,
            effort: profile.effort ?? 'default',
            instruction: profile.instruction,
          },
          config.stateDir,
        ), this.consumption),
    });
    this.readyReviews = new ReadyReviewManager({
      interactions: this.sessions.interactions, runs: this.sessions.runs, executor: this.executor,
      maxRuntimeMs: () => this.settings.value.execution.maxRuntimeMs,
      assertCanAdmit: () => { const hold = sharedFeatureAdmissionHold(this); if (hold) throw new DomainError('unavailable', hold.message); },
      authorize: authority => authorizeDeliveryPolicy(this, authority.repositoryId, authority.configurationDigest),
      verifyAuthority: authority => authorizeIsolatedDeliveryPolicy(this, authority.repositoryId, authority.configurationDigest),
      profile: input => readyReviewProfile(input, this.settings.provider(input.provider), selectors => this.definitions.select(selectors)),
      model: readyReviewModels(config.stateDir, this.settings, this.consumption, this.sessions.runs, this.processObservations),
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
      active: () => this.executor.executions,
      log: (event) =>
        serviceEvent(
          "worker",
          event,
          event === "resource_alert_resolved" ? "info" : "warn",
        ),
    });
    const primary = createProjectFeatureRuntime(this, {
      primary: true, repository: config.projectDir ?? process.cwd(), stateDirectory: config.stateDir,
      ...(config.features ? { directory: config.features.directory } : {}), pollMs: config.features?.pollMs ?? 1000,
    });
    this.sharedRuntime = primary.sharedRuntime;
    this.featureProjects = new WorkspaceProjectIntakes(this, primary);
  }
}
