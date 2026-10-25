import { sessionFeatureRequest } from './feature-request-reference.js';
import { workerCapacitySnapshot, type WorkerCapacityContext } from './worker-capacity.js';
import type { SessionCatalog } from './session-catalog.js';
import type { FeatureTrackingRecord, FeatureTrackingStatus } from './feature-tracking.js';
import type { SessionView } from './workspace-view.js';
import type { WorkerSettingsPort } from './workspace-ports.js';
import type { WorkerConversation } from './conversation.js';
import type { RequestJournal, InteractionJournal } from './journal-ports.js';
import type { SerialExecutor } from './serial-executor.js';

interface SessionViewContext {
  catalog: SessionCatalog;
  featureTracking?: { status(): FeatureTrackingStatus; record(id: string): FeatureTrackingRecord | undefined };
  capacityContext?: WorkerCapacityContext;
  settings: WorkerSettingsPort;
  instances: Map<string, WorkerConversation>;
  requests: RequestJournal;
  interactions: InteractionJournal;
  executor: SerialExecutor;
  chatActive: number;
  activeOutsideChat(): number;
}

export function sessionView(context: SessionViewContext): SessionView {
    const tracking = context.featureTracking?.status();
    return {
      ...(tracking ? { featureTracking: { directory: tracking.directory, lastSyncedAt: tracking.lastSyncedAt, error: tracking.error } } : {}),
      ...(context.capacityContext ? { capacity: workerCapacitySnapshot({
        capturedAt: new Date().toISOString(), currentSessionId: context.executor.current, activeSessions: context.executor.executions, reservedExecutions: context.executor.reservedExecutions,
        localUsed: context.chatActive + context.activeOutsideChat(), settings: context.settings.value.board,
        remote: context.capacityContext.remote(), consumption: context.capacityContext.consumption(),
      }) } : {}),
      selected: context.catalog.selected,
      execution: {
        currentSessionId: context.executor.current,
        activeSessions: context.executor.executions,
        queued: context.executor.waiting,
        maxParallel: context.executor.limit,
      },
      records: context.catalog.records.map((record) => {
        const conversation = context.instances.get(record.id)?.snapshot(),
          last = conversation?.messages.at(-1);
        const interaction = context.interactions.view(record.id);
        const active =
          context.executor.has(record.id) ||
          conversation?.busy ||
          ["queued", "running"].includes(record.taskState ?? "");
        const failedInteraction = interaction.phase === "failed" && !active;
        let status =
          failedInteraction ||
          ["waiting_input", "escalated", "cancelled", "interrupted"].includes(
            interaction.phase,
          )
            ? interaction.phase
            : context.executor.has(record.id)
              ? "running"
              : conversation?.busy
                ? "queued"
                : (record.taskState ??
                  (!last
                    ? "draft"
                    : last.state === "error"
                      ? "failed"
                      : last.state === "cancelled"
                        ? "cancelled"
                        : "completed"));
        const request = context.requests.forSession(record.id);
        if (
          !active &&
          request &&
          ["readiness", "needs_rework", "review"].includes(request.phase)
        )
          status =
            request.phase === "readiness" ? "needs_rework" : request.phase;
        return {
          ...record,
          ...(record.selection ? { selection: structuredClone(record.selection) } : {}),
          feature: sessionFeatureRequest(record),
          ...(context.featureTracking?.record(record.id) ? { featureRequest: context.featureTracking.record(record.id) } : {}),
          ...(request
            ? {
                requestId: request.id,
                requestPhase: request.phase,
                ...(request.lifecycle ? { requestLifecycle: request.lifecycle } : {}),
                requestRevision: request.revision,
              }
            : {}),
          status,
          interaction,
          busy:
            (conversation?.busy ?? false) ||
            ["queued", "running"].includes(record.taskState ?? ""),
          messages: conversation?.messages.length ?? 0,
        };
      }),
    };
  }
