import type { ResourceStatus } from '../application/resources.js';
import { ageSeconds, monitoringReport, operationalAlert, type MonitoringThresholds } from '../../shared/monitoring.js';

export interface Status {
  machineId?: string;
  queuedTasks?: { id: string; profile: string | null }[];
  queueCapacity?: number;
  workerId: string | null;
  project: string | null;
  mode: "mock" | "cli";
  state: string;
  taskId: string | null;
  attempt: number | null;
  profile: string | null;
  completedReviews?: number;
  outbox?: { pending: number; oldestAgeSeconds: number };
  completedSimulations: number;
  lastContact: string | null;
  lastError: string | null;
  updatedAt: string;
  profiles: { id: string; provider: string; mode: string }[];
  heartbeatErrors: number;
  maxParallel: number;
  activeTasks: { id: string; attempt: number; profile: string | null }[];
  configurationHash: string;
  lastSnapshot: string | null;
}
export function workerMonitoring(
  status: Status,
  thresholds: MonitoringThresholds,
  now = Date.now(),
  resources?: ResourceStatus,
) {
  const connected = ["idle", "executing"].includes(status.state);
  const metrics: Record<string, number> = {
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
