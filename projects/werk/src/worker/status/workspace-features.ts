import { sharedFeaturePolicy } from '../application/shared-feature-policy.js';
import { gateDigest } from '../application/request-gates.js';
import { assertLocalMergeBaseline } from './workspace-local-merge-baseline.js';
import { assertNativeWorkReady } from './workspace-native-work.js';
import { validateSharedIntakeConfig } from '../application/shared-feature-state.js';
import type { FeatureRequests } from '../application/feature-requests.js';
import type { SharedFeatureIntake } from '../application/shared-feature-intake.js';
import { featureDependencyPlan, retainedFeatureDependencyPlans } from './workspace-feature-dependencies.js';
import type { WorkspaceFeatureProject } from './workspace-project-features.js';
import { featureDeliverySubmission } from './workspace-delivery.js';
import { admitFeatureRequest, type FeatureAdmissionPorts } from '../application/feature-admission.js';
import { featureRequestReference, sharedFeatureRequestReference } from '../application/feature-request-reference.js';
import type { WorkspaceContext } from './workspace-context.js';
import type { InteractionCommand } from '../application/interactions.js';
import { interaction } from './workspace-interactions.js';
import { publicTaskConversation } from '../application/public-task-transcript.js';
import { type FeatureTrackingInput } from '../application/feature-tracking.js';
import type { SharedExecution, SharedFeatureRecord } from '../application/shared-feature-state.js';
import { developmentCompletionValid, developmentScopeView } from '../application/development.js';
import { type FeatureRecord } from "../application/feature-requests.js";
import { object, identifier, type Task } from "../../shared/contracts.js";
import { join } from "node:path";
import { DomainError } from "../../shared/errors.js";
import { task } from './workspace-tasks.js';
import { toolAccessBlockedReason, withIdleConfiguration, withRepositoryAdmission } from './workspace-settings.js';

export function featureTrackingSnapshot(workspace: WorkspaceContext): FeatureTrackingInput[]{
  const tasks = new Map(workspace.board.view().tasks.map(task => [task.sessionId, task.id]));
  return workspace.sessions.details().map(({ session, chat }) => {
    const interaction = session.interaction;
    const taskId = tasks.get(session.id), local = taskId ? workspace.board.executionDetail(taskId) : undefined;
    const sharedTaskId = taskId ?? (session.kind === 'local' && session.id.startsWith('local-') ? session.id.slice(6) : undefined);
    const shared = sharedTaskId ? workspace.featureProjects.sharedForTask(sharedTaskId, session.feature?.key) : undefined;
    const folder = workspace.featureProjects.forSession(session.id, session.feature?.key);
    const sharedReference = shared?.reference, folderReference = folder?.reference, sharedSource = shared?.source;
    const sourceRepository = sharedSource && workspace.settings.value.repositories.items.find(item => item.id === sharedSource.repositoryId);
    const sourcePath = sharedSource ? sourceRepository ? join(sourceRepository.path, sharedSource.path) : sharedSource.path : folderReference?.sourcePath ? join(folder!.project.directory!, folderReference.sourcePath) : undefined;
    const reference = sharedReference ?? folderReference;
    const runs = workspace.sessions.runs.list({ sessionId: session.id, limit: 100 }).rows;
    return { session: reference ? { ...session, feature: reference } : session, messages: publicTaskConversation(chat, local ? { instruction: local.instruction, paths: local.admissionFailure?.paths ?? local.files.map(file => file.path) } : undefined).messages, request: workspace.sessions.requests.forSession(session.id),
      turns: interaction.turns.map(turn => workspace.sessions.interactions.turn(session.id, turn.id)), runs,
      ...(local ? { local: { instruction: local.instruction, summary: local.summary, error: local.error, hasPatch: !!local.patch, repository: local.repository, paths: local.files.map(file => file.path), ...(local.implementation ? { implementation: developmentScopeView(local.implementation), developmentEvidence: local.developmentEvidence } : {}) } } : {}),
      ...(sourcePath ? { sourcePath } : {}),
    };
  });
}

/** Explain the local setup preset only while no explicit shared repository binding owns intake. */
const localIntakeHint = { intake: 'local', hint: 'Shared Git intake is intentionally off: this worker was created with init --intake local. Create a request by copying <features>/_templates/local-request.md outside the feature folder, setting paths, then running feature create --markdown <copy>. To use shared intake, run shared setup; its saved repository binding takes precedence over the local setup defaults.' } as const;
const withLocalHint = <T extends object>(workspace: WorkspaceContext, view: T): T | (T & typeof localIntakeHint) => workspace.config.features?.intake === 'local' && !workspace.sharedRuntime.intake.binding?.repositoryId ? { ...view, ...localIntakeHint } : view;

function projectView(workspace: WorkspaceContext, project: WorkspaceFeatureProject) {
  return { selectedProjectId: workspace.featureProjects.id(project), projects: workspace.featureProjects.choices(), dependencyPlans: retainedFeatureDependencyPlans(workspace, workspace.featureProjects.id(project)) };
}
export function sharedIntakeView(workspace: WorkspaceContext, projectId?: string){
  const project = workspace.featureProjects.resolve(projectId);
  const blocked = toolAccessBlockedReason(workspace)?.replaceAll('tool access', 'shared intake') ?? null;
  return { ...(project.primary ? withLocalHint(workspace, project.sharedRuntime.intake.view(blocked)) : project.sharedRuntime.intake.view(blocked)), ...projectView(workspace, project) };
}
export async function sharedIntakeCommand(workspace: WorkspaceContext, input: unknown){
  const body = object(input, 'Shared intake command', ['action', 'expectedRevision', 'config', 'id', 'projectId']);
  const projectId = body.projectId === undefined ? undefined : identifier(body.projectId, 'projectId');
  const project = workspace.featureProjects.resolve(projectId);
  const intake: SharedFeatureIntake = project.sharedRuntime.intake;
  if (body.action === 'configure') {
    if (body.id !== undefined || !Number.isSafeInteger(body.expectedRevision)) throw new DomainError('invalid_input', 'Save shared intake with its current revision.');
    const config = validateSharedIntakeConfig(body.config);
    await withIdleConfiguration(workspace, async () => {
      workspace.featureProjects.assertSharedBinding(project, config.repositoryId);
      await intake.configure(config, Number(body.expectedRevision));
      await workspace.featureProjects.configure();
    });
    return sharedIntakeView(workspace, workspace.featureProjects.id(project));
  }
  if (body.config !== undefined || body.expectedRevision !== undefined) throw new DomainError('invalid_input', 'Configuration fields are only accepted when saving shared intake.');
  if (body.action === 'sync' && body.id === undefined) {
    assertNativeWorkReady(workspace);
    if (!workspace.acceptingTasks || workspace.configurationUpdating || workspace.repositoriesUpdating) throw new DomainError('unavailable', 'Worker configuration is changing or the worker is stopping.');
    await project.sharedRuntime.intake.sync();
    return sharedIntakeView(workspace, projectId);
  }
  if (body.action === 'note') return intake.note(identifier(body.id, 'feature ID'));
  throw new DomainError('invalid_input', 'Use configure, sync or note for shared intake.');
}
export function featureView(workspace: WorkspaceContext, projectId?: string){
  const project = workspace.featureProjects.resolve(projectId);
  const view = project.sharedRuntime.intake.binding?.repositoryId ? { enabled: false, reason: 'Shared repository intake is configured.' } : project.features?.view() ?? { enabled: false };
  return { ...(project.primary ? withLocalHint(workspace, view) : view), ...projectView(workspace, project) };
}
export async function featureList(workspace: WorkspaceContext, projectId?: string){
  const project = workspace.featureProjects.resolve(projectId);
  if (project.sharedRuntime.intake.binding?.repositoryId) return featureView(workspace, projectId);
  const features: FeatureRequests | undefined = project.features;
  const view = await features?.list() ?? { enabled: false };
  return { ...(project.primary ? withLocalHint(workspace, view) : view), ...projectView(workspace, project) };
}
export async function featureCommand(workspace: WorkspaceContext, input: unknown){
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DomainError('invalid_input', 'Feature command must be an object.');
  const raw = input as { projectId?: unknown; action?: unknown };
  const project = workspace.featureProjects.resolve(raw?.projectId === undefined ? undefined : identifier(raw.projectId, 'projectId'));
  if (raw.action === 'dependency_plan') { const command = object(input, 'Dependency plan', ['action', 'projectId', 'id']); return featureDependencyPlan(workspace, project, identifier(command.id, 'Feature ID')); }
  const features: FeatureRequests | undefined = project.features;
  if (!features) throw new DomainError('conflict', 'Configure a feature folder for this project first.');
  if (project.sharedRuntime.intake.binding?.repositoryId && !['get', 'result', 'validate'].includes(String(raw?.action))) throw new DomainError('conflict', 'Shared Git intake owns new feature requests. Create and validate the request in the repository, then commit and push it.');
  const { projectId: _projectId, ...command } = input as Record<string, unknown>;
  return features.action(command);
}

export function inspectSharedFeature(workspace: WorkspaceContext, id: string): SharedExecution | undefined{
  try {
    const task = workspace.board.executionDetail(id);
    return { status: task.status, summary: task.summary, patch: task.patch, interaction: task.interaction,
      ...(task.implementation ? { implementation: developmentScopeView(task.implementation), developmentEvidence: task.developmentEvidence, developmentVerified: developmentCompletionValid(task) } : {}),
      request: task.requestId ? workspace.sessions.requests.get(task.requestId) : null, currentTurnId: task.currentTurnId, runId: task.runId, error: task.error };
  } catch { return undefined; }
}

/** Markdown replies use the same authority and durable operation ledger as UI replies. */
export async function continueFeatureInteraction(workspace: WorkspaceContext, sessionId: string, command: InteractionCommand) {
  if (command.sessionId !== sessionId) throw new DomainError('invalid_input', 'This Task note belongs to another worker interaction.');
  const acknowledged = workspace.sessions.interactions.operation(sessionId, command.operationId);
  if (acknowledged) {
    return workspace.sessions.interactions.accept({
      sessionId, operationId: command.operationId, kind: command.action,
      expectedRevision: command.expectedRevision, pendingId: command.pendingId, priorTurnId: command.turnId,
      input: (command.action === 'answer' ? command.answer : command.message) ?? '',
    }).view;
  }
  if (!workspace.acceptingTasks || workspace.configurationUpdating || workspace.repositoriesUpdating || workspace.executionProfiles?.pending()) throw new DomainError('unavailable', 'Task response is saved. It will resume after the worker is available.');
  if (workspace.consumption.status().blocked) throw new DomainError('unavailable', 'Task response is saved. The worker consumption limit currently prevents execution.');
  if ((workspace.sessions.admissionActive ?? workspace.sessions.chatActive) + workspace.board.active >= workspace.settings.value.board.queueCapacity) throw new DomainError('unavailable', 'Task response is saved. It will resume when queue capacity is available.');
  return interaction(workspace, command, { fromFeatureNote: true });
}

function featureAdmissionPorts(workspace: WorkspaceContext): FeatureAdmissionPorts {
  return {
    patch: (input, reservation) => workspace.board.create(input, reservation),
    chat: (input, reference, selection) => task(workspace, input, reference, selection),
  };
}

export async function submitSharedFeature(workspace: WorkspaceContext, record: SharedFeatureRecord){
  return withRepositoryAdmission(workspace, async () => {
    const assignment = workspace.repositories.resolve(record.binding.repositoryId);
    if (record.accepted.mode === 'patch') await assertLocalMergeBaseline(workspace, assignment.path, record.binding.repositoryId, record.sourceCommit, record.taskId ?? undefined);
    const effectivePolicy = sharedFeaturePolicy(record);
    const delivery = record.deliveryPolicy ? await featureDeliverySubmission(workspace, { id: record.id, input: record.accepted, deliveryPolicy: record.deliveryPolicy, deliveryExecution: record.deliveryExecution }, assignment.path, record.workflow.policy) : undefined;
    if (delivery && gateDigest(delivery.policy) !== effectivePolicy.digest) throw new DomainError('conflict', 'Shared admission changed its frozen effective execution policy. Restore the accepted workflow and delivery profile.');
    await admitFeatureRequest(featureAdmissionPorts(workspace), {
      input: record.accepted, taskId: record.taskId!, submissionHash: record.inputHash, repository: assignment.path,
      reference: sharedFeatureRequestReference(record), selection: record.selection,
      submission: { ...delivery, ...(record.selection ? { selection: record.selection } : {}), policy: effectivePolicy.policy, ...(record.workflow.definitionPrompts ? { definitionPrompts: record.workflow.definitionPrompts } : {}), criteria: record.accepted.criteria, repositoryId: record.binding.repositoryId, baseCommit: record.sourceCommit },
    });
    await workspace.featureTracking.sync();
  });
}

export async function rememberTask(workspace: WorkspaceContext, task: Task){
  await workspace.taskIndex.remember(task);
  const reference = featureRequestReference({ id: task.source?.featureId ?? task.id, source: 'orchestrator', scope: workspace.config.url ? new URL(workspace.config.url).origin : 'legacy-worker-assignment' });
  await workspace.features?.rememberRemote(task, reference);
  await workspace.sessions.ensureTask(
    "remote-" + task.id,
    "orchestrator",
    task.title,
    task.provider === "claude" ? "claude-cli" : "codex-cli",
    undefined, undefined,
    reference,
  );
  await workspace.featureTracking.sync();
  workspace.historyCache = undefined;
}

export async function submitFeature(workspace: WorkspaceContext, record: FeatureRecord, project = workspace.featureProjects.forRecord(record)){
  return withRepositoryAdmission(workspace, async () => {
    const repository = project.repository;
    const submission = record.input?.mode === 'patch' && (record.input.requestSchema === 'worker.request/v1' || record.deliveryPolicy) ? await featureDeliverySubmission(workspace, record, repository, workspace.sessions.requests.policy().policy) : undefined;
    await admitFeatureRequest(featureAdmissionPorts(workspace), {
      input: record.input!, taskId: record.taskId, submissionHash: record.inputHash, selection: record.selection,
      repository, ...(submission ? { submission } : {}),
      reference: record.feature ? { ...record.feature, sourcePath: record.name, repositoryId: workspace.featureProjects.id(project) } : featureRequestReference({ id: record.id, source: 'folder', scope: project.features!.view().directory, sourcePath: record.name }),
    });
    await workspace.featureTracking.sync();
  });
}

/** Priority is scheduling metadata; it never revises requirements or starts another run. */
export async function reprioritizeFeature(workspace: WorkspaceContext, record: FeatureRecord, priority: number) {
  if (!workspace.acceptingTasks || workspace.configurationUpdating || workspace.repositoriesUpdating || workspace.executionProfiles?.pending() || record.source !== 'folder' || record.input?.mode !== 'patch') return false;
  const task = workspace.board.view().tasks.find(item => item.id === record.taskId);
  if (!task || task.status !== 'queued') return false;
  if (task.sessionId !== record.sessionId || record.feature && task.feature?.key !== record.feature.key) throw new DomainError('conflict', 'The queued task belongs to another Feature Request.');
  await workspace.board.action({ action: 'priority', id: task.id, priority });
  return true;
}

function executionEvidence(workspace: WorkspaceContext, sessionId: string, runId?: string){
  const run = runId
    ? workspace.sessions.runs.get(runId)
    : workspace.sessions.runs.latest(sessionId);
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

export function inspectFeature(workspace: WorkspaceContext, record: FeatureRecord){
  try {
    if (record.input?.mode === "patch") {
      const task = workspace.board.executionDetail(record.taskId);
      return {
        request: task.requestId
          ? workspace.sessions.requests.get(task.requestId)
          : undefined,
        interaction: workspace.sessions.interactions.view(task.sessionId),
        evidence: task.runId
          ? executionEvidence(workspace, task.sessionId, task.runId)
          : undefined,
        status: workspace.board.view().persistenceError ? "unsaved" : task.status,
        text: task.summary ?? task.error ?? undefined,
        patch: task.patch ?? undefined,
        error: task.error ?? undefined,
      };
    }
    const detail = workspace.sessions.detail(record.sessionId),
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
      request: workspace.sessions.requests.forSession(record.sessionId),
      interaction: workspace.sessions.interactions.view(record.sessionId),
      evidence: executionEvidence(workspace, record.sessionId),
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
