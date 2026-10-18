import { sessionFeatureRequest } from './feature-request-reference.js';
import { WorkerConversation } from './conversation.js';
import { definitionConnection } from './definitions.js';
import type { SessionRecord } from './session-catalog.js';
import type { WorkerSettingsPort, SessionCatalogStorage } from './workspace-ports.js';
import type { ModelFactory } from './provider-contract.js';
import type { RequestJournal, InteractionJournal, RunJournal } from './journal-ports.js';
import type { SerialExecutor } from './serial-executor.js';
import type { GatePolicy } from './request-gates.js';
import { DomainError } from '../../shared/errors.js';

interface SessionConversationContext {
  storage: SessionCatalogStorage;
  settings: WorkerSettingsPort;
  model: ModelFactory;
  executor: SerialExecutor;
  runs: RunJournal;
  interactions: InteractionJournal;
  requests: RequestJournal;
  instances: Map<string, WorkerConversation>;
  requestPolicy(): GatePolicy | undefined;
  notifyRequest(id: string): void;
  assertCanContinue(id: string): void;
  chatActive(): number;
  activeOutsideChat(): number;
}

export async function loadSessionConversation(context: SessionConversationContext, record: SessionRecord) {
    const store = await context.storage.conversation(record.id);
    const model = context.model(
      definitionConnection(
        context.settings.provider(record.provider),
        record.definition,
      ),
      { sessionId: record.id },
    );
    const conversation = new WorkerConversation(
      store,
      model,
      () => context.settings.value.execution.maxRuntimeMs,
      context.executor,
      record.id,
      {
        journal: context.runs,
        interactions: context.interactions,
        requests: context.requests,
        requestPolicy: () => context.requestPolicy?.(),
        notifyRequest: (id) => context.notifyRequest(id),
        admit: () => {
          context.assertCanContinue(record.id);
          if (
            context.chatActive() + context.activeOutsideChat() >=
            context.settings.value.board.queueCapacity
          )
            throw new DomainError("conflict", "Worker task queue is full.");
        },
        provider: () => {
          const connection = definitionConnection(
            context.settings.provider(record.provider),
            record.definition,
          );
          return {
            id: connection.id,
            model: connection.model,
            instruction: connection.instruction ?? "",
          };
        },
        feature: () => sessionFeatureRequest(record),
        metadata: () => ({
          sessionId: record.id,
          taskId: record.taskId,
          kind: record.kind,
          title: record.title,
          provider: record.provider,
          model:
            record.definition?.model ||
            context.settings.provider(record.provider).model,
        }),
      },
    );
    await conversation.init();
    context.instances.set(record.id, conversation);
  }
