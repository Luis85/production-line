import { stopSessionProcesses } from './workspace-processes.js';
import { admitFeatureRequest } from '../application/feature-admission.js';
import { interactionFeatureRequest, sessionFeatureRequest, type FeatureRequestReference } from '../application/feature-request-reference.js';
import { assertDirectFeatureCreation, isSharedFeatureSession } from './workspace-feature-authoring.js';
import type { WorkspaceContext } from './workspace-context.js';
import { validateApprovedPaths } from '../application/approved-paths.js';
import { definitionConnection, definitionSelection } from "../application/definitions.js";
import { object, text, identifier } from "../../shared/contracts.js";
import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "../../shared/errors.js";
import { withFeatureTracking, taskDetail, assertTaskCanContinue } from './workspace-task-views.js';
import { withRepositoryAdmission } from './workspace-settings.js';

/** Address sessions directly; automation never changes the browser's selected task. */
export async function task(workspace: WorkspaceContext, input: unknown, reference?: FeatureRequestReference){
  const operation = workspace.taskRequests
    .catch(() => {})
    .then(async () => {
      if (!workspace.acceptingTasks)
        throw new DomainError("unavailable", "Worker is stopping.");
      const body = object(input, "Task command", [
        "action",
        "id",
        "title",
        "provider",
        "message",
        "definitionId",
        "definitionRef",
        "agent",
        "useInstructionsOnly",
        "files",
        "background",
      ]);
      if (body.background !== undefined && (typeof body.background !== "boolean" || body.action !== "create" || body.background && body.files === undefined))
        throw new DomainError("invalid_input", "background is a true/false option when creating a task with approved files.");
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
        (body.files !== undefined || body.definitionId !== undefined ||
          body.definitionRef !== undefined ||
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
      if (body.action === 'create' && !reference) {
        const retained = workspace.sessions.view().records.find(item => item.id === id || item.id === 'local-' + id && item.kind === 'local');
        const admitted = retained?.kind === 'local'
          ? workspace.board.view().tasks.some(item => item.id === id && item.sessionId === retained.id)
          : retained?.submissionHash && workspace.sessions.detail(retained.id).chat.messages.length > 0;
        // A confirmed legacy receipt may be replayed after shared intake is configured.
        // Exact input and identity are still checked below; an empty session cannot admit new work.
        if (!admitted) assertDirectFeatureCreation(workspace);
      }
      if (body.action === "get") return workspace.sessions.detail(id);
      if (body.action === "cancel") { const result = await workspace.sessions.cancelTask(id); await stopSessionProcesses(workspace, id); return result; }
      if (workspace.configurationUpdating || workspace.executionProfiles?.pending())
        throw new DomainError("conflict", "Finish the execution profile change before starting new work.");
      if (body.action !== 'create') {
        assertTaskCanContinue(workspace, id);
        if (isSharedFeatureSession(workspace, id)) throw new DomainError('conflict', 'Continue this Feature Request using its Task answer or resume control. Publish a new Feature Request to change the accepted scope.');
      }
      let requestMessage = body.message;
      if (body.action === "retry") {
        const detail = workspace.sessions.detail(id);
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
        const files = body.files === undefined ? undefined : object(body.files, 'Approved task files', ['repository', 'paths']);
        const approved = files ? { repository: text(files.repository, 'repository', 4096), paths: validateApprovedPaths(files.paths) } : undefined;
        // File request IDs and their generated session IDs share the task namespace.
        const aliasesPendingPreparation = (!approved && workspace.board.preparation(id)) ||
          (id.startsWith("local-") && workspace.board.preparation(id.slice(6)));
        const aliasesFileRequest = approved && (
          workspace.board.preparation("local-" + id) ||
          workspace.board.view().tasks.some(task => task.id === "local-" + id) ||
          workspace.sessions.view().records.some(session => session.kind === "local" && session.id === "local-local-" + id)
        );
        if (aliasesPendingPreparation || aliasesFileRequest)
          throw new DomainError("conflict", "Task id already belongs to another approved-file request.");
        if (approved && !/^[a-z0-9-]{1,90}$/.test(id)) throw new DomainError('invalid_input', 'File task IDs use 1–90 lowercase letters, digits or hyphens.');
        const selection = definitionSelection(body);
        const title = text(body.title, "title", 120),
          provider = workspace.settings.provider(String(body.provider));
        const existing = workspace.sessions
          .view()
          .records.find((item) => item.id === (approved ? "local-" + id : id));
        if (reference && existing && sessionFeatureRequest(existing).key !== reference.key)
          throw new DomainError('conflict', 'Task id already belongs to another Feature Request.');
        const savedDefinition = existing?.definition ?? (approved ? workspace.board.preparationDefinition(id) : undefined);
        const definition =
          savedDefinition &&
          (selection.definitionRef !== undefined
            ? selection.definitionRef === savedDefinition.ref
            : selection.definitionId === savedDefinition.definitionId) &&
          (body.agent ?? "root") === savedDefinition.agent &&
          (!savedDefinition.adapted || body.useInstructionsOnly === true)
            ? savedDefinition
            : workspace.definitions.select(body);
        definitionConnection(provider, definition);
        const submissionHash = createHash("sha256")
          .update(
            JSON.stringify({
              title,
              provider: provider.id,
              message,
              ...(approved ? { files: approved } : {}),
              ...(definition ? { definition } : {}),
            }),
          )
          .digest("hex");
        const fileTask = workspace.board.view().tasks.find(task => task.id === id);
        const feature = reference ?? existing?.feature ?? interactionFeatureRequest(id);
        const admit = () => admitFeatureRequest({
          patch: (command, submission) => withRepositoryAdmission(workspace, () => workspace.board.create(command, submission)),
          chat: () => withRepositoryAdmission(workspace, () => workspace.sessions.ensureTask(id, 'chat', title, provider.id, submissionHash, definition, feature)),
        }, {
          input: { title, message, provider: provider.id, mode: approved ? 'patch' : 'chat', priority: 1,
            ...(approved ? { paths: approved.paths } : {}), ...selection, agent: body.agent as string | undefined, useInstructionsOnly: body.useInstructionsOnly as boolean | undefined },
          reference: feature, taskId: id, submissionHash, repository: approved?.repository,
          background: body.background === true,
        });
        if (approved) {
          if (workspace.sessions.view().records.some(session => session.id === id) || existing && (existing.kind !== 'local' || !fileTask && existing.submissionHash !== submissionHash))
            throw new DomainError('conflict', 'Task id already belongs to different input.');
          await admit();
          const preparation = workspace.board.preparation(id);
          if (preparation) return { preparation };
          return workspace.sessions.detail(workspace.board.executionDetail(id).sessionId);
        }
        if (fileTask || workspace.sessions.view().records.some(session => session.id === 'local-' + id && session.kind === 'local')) throw new DomainError('conflict', 'Task id already belongs to different input.');
        if (existing) {
          const detail = workspace.sessions.detail(id);
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
          (workspace.sessions.admissionActive ?? workspace.sessions.chatActive) + workspace.board.active >=
          workspace.settings.value.board.queueCapacity
        )
          throw new DomainError("conflict", "Worker task queue is full.");
        await admit();
      }
      if (
        (workspace.sessions.admissionActive ?? workspace.sessions.chatActive) + workspace.board.active >=
        workspace.settings.value.board.queueCapacity
      )
        throw new DomainError("conflict", "Worker task queue is full.");
      await withRepositoryAdmission(workspace, () => workspace.sessions.start(message, id));
      return workspace.sessions.detail(id);
    });
  workspace.taskRequests = operation.then(
    () => {},
    () => {},
  );
  const detail = await withFeatureTracking(workspace, () => operation);
  // Preparation progress is not durable admission; only a real session acknowledges the request.
  if ("preparation" in detail) return detail;
  const { directory, lastSyncedAt, error } = workspace.featureTracking.status();
  return { ...taskDetail(workspace, detail.session.id), featureTracking: { directory, lastSyncedAt, error } };
}
