import type { CapacityConsumption, WorkerCapacitySnapshot } from '../application/worker-capacity';

export type CapacityFreshness = 'fresh' | 'stale' | 'unknown';
export interface WorkerCapacityView {
  state: 'running' | 'paused' | 'blocked' | 'available' | 'unknown';
  title: string;
  description: string;
  stale: boolean;
  executionLabel: string;
  localLabel: string;
  remoteLabel: string;
  admissionAvailable: boolean | null;
  startBlocked: boolean | null;
}
function consumptionBlock(value: CapacityConsumption | null): string {
  if (!value?.blocked) return '';
  switch (value.reason) {
    case 'accounting_unavailable': return 'Usage accounting is unavailable. Check worker storage before restarting.';
    case 'unmeasured_usage': return 'Incomplete token usage blocks new model calls until the next UTC reset.';
    case 'exhausted': return 'The worker token allowance is exhausted. Review consumption limits or wait for the next UTC reset.';
    case 'insufficient_reservation': return 'The remaining allowance cannot cover another model call reservation.';
    default: return 'Consumption controls block new model calls. Review the saved limits.';
  }
}
/** Shared dashboard/taskboard wording uses measured admission facts and never predicts completion time. */
export function buildWorkerCapacityView(capacity: WorkerCapacitySnapshot | null | undefined, freshness: CapacityFreshness = 'fresh'): WorkerCapacityView {
  const missing: WorkerCapacityView = { state: 'unknown', title: 'Worker activity is unavailable', description: 'Refresh to check the execution slot and admission limits.', stale: freshness !== 'fresh', executionLabel: 'Execution slot unavailable', localLabel: 'Local capacity unavailable', remoteLabel: 'Remote assignments unavailable', admissionAvailable: null, startBlocked: null };
  if (!capacity) return missing;
  const view: WorkerCapacityView = {
    ...missing,
    executionLabel: capacity.execution.inUse + ' / 1 task slot occupied',
    localLabel: capacity.local.used + ' / ' + capacity.local.limit + ' local places used',
    remoteLabel: capacity.remote.accepted === null ? 'Remote assignments unavailable' : capacity.remote.accepted + ' / ' + (capacity.remote.extraQueuePlaces + 1) + ' assignments accepted',
  };
  if (freshness !== 'fresh') return {
    ...view, title: 'Activity needs refresh', description: 'These are the last reported values. Refresh before relying on capacity or start conditions.', stale: true,
    executionLabel: 'Last reported: ' + view.executionLabel, localLabel: 'Last reported: ' + view.localLabel, remoteLabel: 'Last reported: ' + view.remoteLabel,
  };
  const { paused, consumption } = capacity.starts;
  const block = consumptionBlock(consumption);
  view.admissionAvailable = capacity.local.remaining > 0;
  view.startBlocked = paused || consumption?.blocked === true ? true : consumption ? false : null;
  if (capacity.execution.inUse) return {
    ...view, state: 'running', title: 'Task in progress',
    description: [paused ? 'New starts are paused.' : '', block, !consumption ? 'Consumption readiness is unavailable.' : '', paused || block ? 'The active model call can finish.' : 'Requests, reviews and assignments share this execution slot.'].filter(Boolean).join(' '),
  };
  if (paused) return { ...view, state: 'paused', title: 'New starts paused', description: ['Accepted tasks stay in place. Resume removes the manual pause.', block].filter(Boolean).join(' ') };
  if (block) return { ...view, state: 'blocked', title: 'New model calls are blocked', description: block };
  if (!consumption) return { ...view, title: 'Start conditions need refresh', description: 'The execution slot is free, but consumption readiness is unavailable. Refresh to check it.' };
  return { ...view, state: 'available', title: 'Execution slot available', description: capacity.local.remaining > 0 ? 'Waiting work can start. New requests can join within the local admission limit.' : 'Waiting work can start. Local admission is full; accepted tasks remain queued.' };
}
