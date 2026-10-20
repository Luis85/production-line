import { assertNativeWorkReady } from './workspace-native-work.js';
import type { SharedFeatureIntake } from '../application/shared-feature-intake.js';
import type { WorkspaceContext } from './workspace-context.js';
import type { InteractionCommand } from "../application/interactions.js";
import { object, text, identifier } from "../../shared/contracts.js";
import { DomainError } from "../../shared/errors.js";
import { assertTaskCanContinue } from './workspace-task-views.js';
import { isSharedFeatureSession } from './workspace-feature-authoring.js';

export async function interaction(workspace: WorkspaceContext, input: unknown, options: { fromFeatureNote?: boolean } = {}){
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
  const detail = workspace.sessions.detail(sessionId);
  if (body.action === "get")
    return workspace.sessions.interactions.view(sessionId);
  if (body.action === "events")
    return workspace.sessions.interactions.events(
      sessionId,
      body.after as number | undefined,
      body.limit as number | undefined,
    );
  if (body.action === "turn")
    return workspace.sessions.interactions.turn(
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
    workspace.sessions.interactions.abandon(
      sessionId,
      Number(body.expectedRevision),
      identifier(body.operationId, "operationId"),
      identifier(body.pendingId, "pendingId"),
    );
    const current = workspace.sessions.interactions.view(sessionId);
    const local = workspace.board
      .view()
      .tasks.find((task) => task.sessionId === sessionId);
    if (
      current.phase === "cancelled" &&
      local &&
      ["waiting_input", "escalated"].includes(local.status)
    )
      await workspace.board.action(
        { id: local.id, action: "cancel" },
        current.revision,
      );
    return workspace.sessions.interactions.view(sessionId);
  }
  if (!["answer", "resume"].includes(String(body.action)))
    throw new DomainError(
      "invalid_input",
      "Interaction action: get|turn|answer|resume|cancel",
    );
  if (workspace.configurationUpdating || workspace.executionProfiles?.pending())
    throw new DomainError("conflict", "Finish the execution profile change before starting new work.");
  if (!workspace.acceptingTasks)
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
  assertTaskCanContinue(workspace, sessionId);
  const command = body as unknown as InteractionCommand;
  const local = workspace.board.view().tasks.find(task => task.sessionId === sessionId);
  if (local) assertNativeWorkReady(workspace);
  if (isSharedFeatureSession(workspace, sessionId)) {
    if (!local || !workspace.featureProjects.sharedForTask(local.id)?.source)
      throw new DomainError('conflict', 'This shared Feature Request’s execution history is unavailable. Restore its owning task history before continuing, or create a successor Feature Request.');
    const intake: SharedFeatureIntake = workspace.featureProjects.sharedForTask(local.id)!.project.sharedRuntime.intake;
    if (!options.fromFeatureNote) return intake.respond(local.id, command);
  }
  const interactions = workspace.sessions.interactions;
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
  if (
    detail.session.kind === "local" &&
    local &&
    operation === "patch" &&
    context?.taskId === local.id
  )
    return workspace.board.interact(command);
  return workspace.sessions.interact(command);
}
