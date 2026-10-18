import type { WorkerProcessesView } from '../src/worker/application/process-observation';

/** Deterministic fictional snapshots; never launches or adopts a process. */
export function processExample(empty = false, missing = false): WorkerProcessesView {
  const at = Date.now(), capturedAt = new Date(at).toISOString();
  const common = { platform: 'linux', capturedAt, cpuTotalMicros: missing ? null : 12_500_000, rssBytes: missing ? null : 184_000_000, processCount: missing ? null : 3, coverage: missing ? 'unavailable' as const : 'complete_group' as const, unavailableReason: missing ? 'Process-group resources are unavailable on this platform.' : null };
  const service = {
    id: 'service-example', revision: 4, presetId: 'development-server', name: 'Project development server', featureRequestKey: 'fr-' + 'a'.repeat(64), sessionId: 'running', taskId: 'task-running', runId: 'run-running',
    state: 'running' as const, generation: 1, restartCount: 0, restartLimit: 2, createdAt: new Date(at - 600_000).toISOString(), startedAt: new Date(at - 600_000).toISOString(), endedAt: null, expiresAt: new Date(at + 3000_000).toISOString(),
    readiness: 'reported' as const, readyAt: new Date(at - 598_000).toISOString(), lastExit: null, error: null, measurement: { ...common, scope: 'owned_service_process_group' as const }, controls: { stop: true, restart: true, restartUnavailableReason: null },
  };
  const finite = { id: 'process-example', kind: 'provider' as const, label: 'Model invocation', featureRequestKey: service.featureRequestKey, sessionId: 'running', taskId: 'task-running', runId: 'run-running', state: 'running' as const, startedAt: new Date(at - 60_000).toISOString(), endedAt: null, exitCode: null, measurement: { ...common, scope: 'owned_execution_process_group' as const } };
  const summary = { rssBytes: empty || missing ? null : common.rssBytes, cpuTotalMicros: empty || missing ? null : common.cpuTotalMicros, measuredGroups: empty || missing ? 0 : 1, activeGroups: empty ? 0 : 1, coverage: empty || missing ? 'unavailable' as const : 'complete' as const };
  return { schemaVersion: 1, capturedAt,
    services: { schemaVersion: 1, scope: 'worker_owned_services', capturedAt, sampleIntervalMs: 5000, services: empty ? [] : [service], capacity: { active: empty ? 0 : 1, maximum: 4 }, summary: { running: empty ? 0 : 1, starting: 0, failed: 0, restarts: 0, ...summary }, persistenceError: false },
    executions: { schemaVersion: 1, scope: 'worker_launched_finite_processes', capturedAt, sampleIntervalMs: 1000, retention: { limit: 100, scope: 'current_worker_process' }, processes: empty ? [] : [finite], summary: { active: empty ? 0 : 1, total: empty ? 0 : 1, ...summary } },
  };
}
