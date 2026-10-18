import { interactionFeatureRequest } from './feature-request-reference.js';
import { randomUUID } from 'node:crypto';
import { object, text } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import { type WorkerDefinitions } from './definitions.js';
import { draftSessionSelection } from './session-model-selection.js';
import type { SessionCatalog, SessionRecord } from './session-catalog.js';
import type { WorkerSettingsPort } from './workspace-ports.js';
import type { WorkerConversation } from './conversation.js';
import type { RequestJournal, InteractionJournal } from './journal-ports.js';
import type { SerialExecutor } from './serial-executor.js';
import type { SessionView } from './workspace-view.js';

interface SessionActionContext {
  catalog: SessionCatalog;
  settings: WorkerSettingsPort;
  definitions: WorkerDefinitions;
  instances: Map<string, WorkerConversation>;
  requests: RequestJournal;
  interactions: InteractionJournal;
  executor: SerialExecutor;
  protectedTasks: Set<string>;
  load(record: SessionRecord): Promise<void>;
  persist(): Promise<void>;
  view(): SessionView;
}

export async function sessionAction(context: SessionActionContext, input: unknown) {
    if (context.catalog.changing)
      throw new DomainError("conflict", "Session change in progress.");
    context.catalog.changing = true;
    const previous = structuredClone({
      records: context.catalog.records,
      selected: context.catalog.selected,
    });
    let deleted: string | undefined;
    let indexCommitted = false;
    try {
      const body = object(input, "Session action", [
        "action",
        "id",
        "title",
        "provider",
        "model",
        "effort",
        "definitionId",
        "definitionRef",
        "agent",
        "useInstructionsOnly",
      ]);
      if (body.action === "create") {
        if (context.catalog.records.length >= 100)
          throw new DomainError(
            "conflict",
            "Session limit reached (100). Delete an unused session first.",
          );
        const provider = context.settings.provider(String(body.provider ?? context.settings.value.defaultProvider ?? "codex-cli"));
        const definition = context.definitions.select(body);
        const selection = draftSessionSelection(provider, body, definition);
        const id = randomUUID();
        const record: SessionRecord = {
          ...(selection ? { selection } : {}),
          ...(definition ? { definition } : {}),
          id,
          taskId: id,
          feature: interactionFeatureRequest(id),
          kind: "chat",
          title: text(body.title, "Session title", 120),
          provider: provider.id,
          archived: false,
          createdAt: new Date().toISOString(),
        };
        await context.load(record);
        context.catalog.records.push(record);
        context.catalog.selected = record.id;
      } else {
        if (
          body.provider !== undefined || body.model !== undefined || body.effort !== undefined ||
          body.definitionId !== undefined ||
          body.definitionRef !== undefined ||
          body.agent !== undefined ||
          body.useInstructionsOnly !== undefined
        )
          throw new DomainError(
            "invalid_input",
            "Model selection and agent instructions are fixed when a task is created. Create a new task to change them.",
          );
        const record = context.catalog.records.find((item) => item.id === body.id);
        if (!record) throw new DomainError("not_found", "Session not found");
        if (body.action === "select") {
          record.archived = false;
          context.catalog.selected = record.id;
        } else if (body.action === "restore") record.archived = false;
        else if (body.action === "rename")
          record.title = text(body.title, "Session title", 120);
        else if (body.action === "archive" || body.action === "delete") {
          if (context.requests.hasActiveReview(record.id))
            throw new DomainError(
              "conflict",
              "Cancel and drain the request reviewer before archiving or deleting this history.",
            );
          if (
            context.instances.get(record.id)?.snapshot().busy ||
            context.executor.current === record.id ||
            ["queued", "running"].includes(record.taskState ?? "")
          )
            throw new DomainError("conflict", "Stop the reply first.");
          const next = context.catalog.records.find(
            (item) => item.id !== record.id && !item.archived,
          );
          if (record.id === context.catalog.selected && !next)
            throw new DomainError(
              "conflict",
              "Create another session before archiving the current one.",
            );
          if (record.id === context.catalog.selected) context.catalog.selected = next!.id;
          if (body.action === "archive") record.archived = true;
          else {
            if (context.protectedTasks.has(record.id))
              throw new DomainError(
                "conflict",
                "Delete the linked local task from History before deleting its session.",
              );
            deleted = record.id;
            context.catalog.records = context.catalog.records.filter((item) => item.id !== record.id);
          }
        } else throw new DomainError("invalid_input", "Unknown session action");
      }
      await context.persist();
      indexCommitted = true;
      // Commit the index before removing history: failed writes must preserve the existing transcript.
      if (deleted) {
        const conversation = context.instances.get(deleted)!;
        await conversation.clear().catch(() => {}); // An unindexed transcript can be cleaned up later.
        await conversation.close();
        context.instances.delete(deleted);
        context.interactions.deleteSession(deleted);
        context.requests.deleteSession(deleted);
      }
      return context.view();
    } catch (error) {
      if (indexCommitted) throw error;
      for (const id of context.instances.keys())
        if (!previous.records.some((record) => record.id === id)) {
          await context.instances.get(id)!.close();
          context.instances.delete(id);
          context.interactions.deleteSession(id);
        }
      context.catalog.records = previous.records;
      context.catalog.selected = previous.selected;
      throw error;
    } finally {
      context.catalog.changing = false;
    }
  }
