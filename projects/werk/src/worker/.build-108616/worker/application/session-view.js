import { sessionFeatureRequest } from './feature-request-reference.js';
import { workerCapacitySnapshot,                            } from './worker-capacity.js';
                                                           
                                                                                          
                                                       
                                                               
                                                            
                                                                             
                                                           

                              
                          
                                                                                                               
                                          
                               
                                             
                           
                                   
                           
                     
                              
 

export function sessionView(context                    )              {
    const tracking = context.featureTracking?.status();
    return {
      ...(tracking ? { featureTracking: { directory: tracking.directory, lastSyncedAt: tracking.lastSyncedAt, error: tracking.error } } : {}),
      ...(context.capacityContext ? { capacity: workerCapacitySnapshot({
        capturedAt: new Date().toISOString(), currentSessionId: context.executor.current,
        localUsed: context.chatActive + context.activeOutsideChat(), settings: context.settings.value.board,
        remote: context.capacityContext.remote(), consumption: context.capacityContext.consumption(),
      }) } : {}),
      selected: context.catalog.selected,
      execution: {
        currentSessionId: context.executor.current,
        queued: context.executor.waiting,
        maxParallel: 1,
      },
      records: context.catalog.records.map((record) => {
        const conversation = context.instances.get(record.id)?.snapshot(),
          last = conversation?.messages.at(-1);
        const interaction = context.interactions.view(record.id);
        const active =
          context.executor.current === record.id ||
          conversation?.busy ||
          ["queued", "running"].includes(record.taskState ?? "");
        const failedInteraction = interaction.phase === "failed" && !active;
        let status =
          failedInteraction ||
          ["waiting_input", "escalated", "cancelled", "interrupted"].includes(
            interaction.phase,
          )
            ? interaction.phase
            : context.executor.current === record.id
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
          feature: sessionFeatureRequest(record),
          ...(context.featureTracking?.record(record.id) ? { featureRequest: context.featureTracking.record(record.id) } : {}),
          ...(request
            ? {
                requestId: request.id,
                requestPhase: request.phase,
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
