                                                                  
import { ageSeconds, monitoringReport, operationalAlert,                           } from '../../shared/monitoring.js';

                         
                     
                                                         
                         
                          
                         
                       
                
                        
                         
                         
                            
                                                         
                               
                             
                           
                    
                                                             
                          
                      
                                                                         
                            
                              
 
export function workerMonitoring(
  status        ,
  thresholds                      ,
  now = Date.now(),
  resources                 ,
) {
  const connected = ["idle", "executing"].includes(status.state);
  const metrics                         = {
    werk_worker_connected: connected ? 1 : 0,
    werk_worker_active_tasks: status.activeTasks.length,
    werk_worker_heartbeat_errors: status.heartbeatErrors,
    werk_worker_last_contact_known: status.lastContact ? 1 : 0,
    werk_worker_last_contact_age_seconds: ageSeconds(
      now,
      status.lastContact ? Date.parse(status.lastContact) : null,
    ),
    werk_outbox_measurement_available: status.outbox ? 1 : 0,
  };
  if (status.outbox) {
    metrics.werk_outbox_pending = status.outbox.pending;
    metrics.werk_outbox_oldest_age_seconds = status.outbox.oldestAgeSeconds;
  }
  if (resources) {
    metrics.werk_worker_resource_alerts = resources.alerts.length;
    metrics.werk_worker_resource_persistence_error = resources.persistenceError
      ? 1
      : 0;
    metrics.werk_worker_resource_sample_error = resources.sampleError ? 1 : 0;
    metrics.werk_worker_resource_sample_known = resources.snapshot ? 1 : 0;
    const sample = resources.snapshot;
    if (sample) {
      metrics.werk_worker_resource_sample_age_seconds = Math.max(
        0,
        (now - Date.parse(sample.capturedAt)) / 1000,
      );
      const values = {
        werk_worker_process_rss_bytes: sample.rssBytes,
        werk_worker_process_heap_used_bytes: sample.heapUsedBytes,
        werk_worker_process_heap_limit_bytes: sample.heapLimitBytes,
        werk_worker_process_cpu_cores: sample.cpuCores,
        werk_worker_process_cpu_percent_available_parallelism:
          sample.cpuPercent,
        werk_worker_state_disk_available_bytes: sample.diskAvailableBytes,
      };
      for (const [key, value] of Object.entries(values))
        if (value !== null && Number.isFinite(value)) metrics[key] = value;
    }
  }
  const alerts = [];
  if (!connected && status.state !== "standalone")
    alerts.push(
      operationalAlert(
        "worker_disconnected",
        "Worker is not connected and ready for work.",
        "Inspect worker lifecycle state, orchestrator availability and enrollment configuration.",
      ),
    );
  if (
    status.outbox &&
    (status.outbox.pending >= thresholds.outboxPending ||
      status.outbox.oldestAgeSeconds >= thresholds.outboxAgeSeconds)
  )
    alerts.push(
      operationalAlert(
        "outbox_backlog",
        "Durable evidence is waiting for acknowledgement.",
        "Restore orchestrator connectivity and inspect delivery errors; preserve the outbox.",
      ),
    );
  if (!status.outbox)
    alerts.push(
      operationalAlert(
        "outbox_unknown",
        "Outbox measurement is unavailable.",
        "Check worker startup and journal initialization.",
      ),
    );
  return monitoringReport("worker", now, metrics, alerts, thresholds);
}
