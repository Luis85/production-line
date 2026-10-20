import { ProviderAuthenticationChanged } from './model-selection.js';
import type { ProviderConnection } from './provider-contract.js';
import { sessionFeatureRequest } from './feature-request-reference.js';
import { WorkerConversation } from './conversation.js';
import { sessionConnection } from './session-model-selection.js';
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
    let connection: ProviderConnection, billingChanged = false;
    try {
      connection = sessionConnection(context.settings, record);
      if (record.continuationBlockedReason === new ProviderAuthenticationChanged().message) delete record.continuationBlockedReason;
    } catch (error) {
      if (!(error instanceof ProviderAuthenticationChanged)) throw error;
      // Historical transcripts remain inspectable when a billing route requires explicit readmission.
      connection = { ...context.settings.provider(record.provider), model: record.selection?.model ?? '', authenticationMode: 'legacy' };
      record.continuationBlockedReason = error.message; billingChanged = true;
    }
    const model = billingChanged ? undefined : context.model(
      connection,
      { sessionId: record.id, feature: sessionFeatureRequest(record) },
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
          context.executor.assertResolved(record.id);
          if (
            context.chatActive() + context.activeOutsideChat() >=
            context.settings.value.board.queueCapacity
          )
            throw new DomainError("conflict", "Worker task queue is full.");
        },
        provider: () => {
          // The loaded conversation and its accepted dispatch share one immutable billing choice.
          return {
            id: connection.id,
            model: connection.model,
            ...(connection.authenticationMode ? { authenticationMode: connection.authenticationMode } : {}),
            ...(record.selection ? { effort: record.selection.effort } : {}),
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
          model: connection.model,
          ...(record.selection?.authenticationMode ? { authenticationMode: record.selection.authenticationMode } : {}),
        }),
      },
    );
    await conversation.init();
    context.instances.set(record.id, conversation);
  }
