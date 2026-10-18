import type { ServiceRecord } from '../application/process-supervision';

export const processStateLabel = (value: string) => ({ starting: 'Starting', running: 'Running', restarting: 'Restarting', stopping: 'Stopping', stopped: 'Stopped', failed: 'Failed', interrupted: 'Interrupted', exited: 'Exited' }[value] ?? value);
export const activeProcess = (value: string) => ['starting', 'running', 'restarting', 'stopping'].includes(value);
export function processDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return 'Unavailable';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? minutes + 'm ' + seconds % 60 + 's' : Math.floor(minutes / 60) + 'h ' + minutes % 60 + 'm';
}
export function serviceLifetime(service: ServiceRecord, now: number): string {
  if (!activeProcess(service.state)) return 'Service ended';
  const expires = Date.parse(service.expiresAt);
  if (!Number.isFinite(expires)) return 'Lifetime unavailable';
  return expires <= now ? 'Lifetime reached · awaiting worker update' : processDuration(expires - now) + ' remaining';
}
export function serviceReadiness(service: ServiceRecord): string {
  return ({ not_configured: 'Readiness not configured', waiting: 'Waiting for readiness output', reported: 'Readiness output received', timed_out: 'Readiness timed out' })[service.readiness];
}
export function processReadState(capturedAt: string | undefined, now: number, paused: boolean, error: string) {
  const time = capturedAt ? Date.parse(capturedAt) : NaN;
  const stale = paused || !!error || !Number.isFinite(time) || now - time > 15000 || time > now + 5000;
  return { stale, label: !capturedAt ? 'No readings yet' : stale ? 'Last reported' : 'Current readings', message: error ? 'Process status could not be refreshed. Last reported values are kept.' : paused ? 'Live updates are paused.' : capturedAt && stale ? 'These process readings are older than expected. Refresh before managing a service.' : '' };
}

interface OwnerSession { id: string; title: string; taskId?: string; feature?: { key: string }; }
interface OwnerTask { id: string; sessionId: string; title: string; feature?: { key: string }; }
/** Delegated process sessions are child attempts, not selectable Feature Request sessions. */
export function processOwner(process: { sessionId: string | null; taskId: string | null; featureRequestKey: string | null }, sessions: readonly OwnerSession[], tasks: readonly OwnerTask[]): { id: string; title: string } | null {
  const direct = sessions.find(row => row.id === process.sessionId);
  const matches = (key?: string) => !process.featureRequestKey || !key || key === process.featureRequestKey;
  if (direct) return matches(direct.feature?.key) ? { id: direct.id, title: direct.title } : null;
  const task = tasks.find(row => row.id === process.taskId);
  if (task) return matches(task.feature?.key) && matches(sessions.find(row => row.id === task.sessionId)?.feature?.key) ? { id: task.sessionId, title: task.title } : null;
  const canonical = process.featureRequestKey ? sessions.filter(row => row.feature?.key === process.featureRequestKey) : [];
  return canonical.length === 1 ? { id: canonical[0].id, title: canonical[0].title } : null;
}
