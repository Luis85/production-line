import { nativeWorkReadiness, type NativeWorkReadinessInput } from './native-work-readiness';
import type { CapacityConsumption, WorkerCapacitySnapshot } from '../application/worker-capacity';

export type CapacityFreshness = 'fresh' | 'stale' | 'unknown';
export interface WorkerCapacityView {
  state: 'running' | 'paused' | 'blocked' | 'available' | 'unknown';
  title: string;
  description: string;
  stale: boolean;
  executionLabel: string;
  unresolvedCount?: number;
  nativeWorkMessage?: string;
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
function capacityView(capacity: WorkerCapacitySnapshot | null | undefined, freshness: CapacityFreshness): WorkerCapacityView {
  const missing: WorkerCapacityView = { state: 'unknown', title: 'Worker activity is unavailable', description: 'Refresh to check the execution slot and admission limits.', stale: freshness !== 'fresh', executionLabel: 'Execution slot unavailable', localLabel: 'Local capacity unavailable', remoteLabel: 'Remote assignments unavailable', admissionAvailable: null, startBlocked: null };
  if (!capacity) return missing;
  const view: WorkerCapacityView = {
    ...missing,
    executionLabel: capacity.execution.inUse + ' / ' + capacity.execution.limit + ' task ' + (capacity.execution.limit === 1 ? 'slot' : 'slots') + ' occupied',
    unresolvedCount: capacity.execution.unresolved?.length ?? 0,
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
  const unresolved = view.unresolvedCount ?? 0;
  const active = capacity.execution.sessions?.length ?? Math.max(0, capacity.execution.inUse - unresolved);
  if (unresolved) return { ...view, state: active ? 'running' : 'unknown', title: active ? active + ' running · ' + unresolved + ' unresolved' : 'Execution outcome needs inspection', description: [unresolved + ' execution ' + (unresolved === 1 ? 'place is' : 'places are') + ' reserved for an unknown outcome. This does not establish a live process or elapsed runtime. Inspect the affected requests before resuming.', paused ? 'New starts are paused.' : 'Other starts still depend on remaining machine and project capacity.', block].filter(Boolean).join(' ') };
  if (capacity.execution.inUse) return {
    ...view, state: 'running', title: capacity.execution.inUse === 1 ? 'Task in progress' : capacity.execution.inUse + ' tasks in progress',
    description: [paused ? 'New starts are paused.' : '', block, !consumption ? 'Consumption readiness is unavailable.' : '', paused || block ? capacity.execution.inUse === 1 ? 'The active model call can finish.' : 'Active model calls can finish.' : 'Requests, reviews and assignments share the configured execution capacity.'].filter(Boolean).join(' '),
  };
  if (paused) return { ...view, state: 'paused', title: 'New starts paused', description: ['Accepted tasks stay in place. Resume removes the manual pause.', block].filter(Boolean).join(' ') };
  if (block) return { ...view, state: 'blocked', title: 'New model calls are blocked', description: block };
  if (!consumption) return { ...view, title: 'Start conditions need refresh', description: 'The execution slot is free, but consumption readiness is unavailable. Refresh to check it.' };
  return { ...view, state: 'available', title: 'Execution capacity available', description: capacity.local.remaining > 0 ? 'Waiting work can start. New requests can join within the local admission limit.' : 'Waiting work can start. Local admission is full; accepted tasks remain queued.' };
}

/** Startup blocks execution independently of durable admission, saved pause and consumption limits. */
export function buildWorkerCapacityView(capacity: WorkerCapacitySnapshot | null | undefined, freshness: CapacityFreshness = 'fresh', nativeWork?: NativeWorkReadinessInput | null): WorkerCapacityView {
  const view = capacityView(capacity, freshness), readiness = nativeWorkReadiness(nativeWork);
  if (!readiness) return view;
  return {
    ...view, startBlocked: true,
    nativeWorkMessage: readiness.message + ' Queue pause and consumption limits still apply.',
    ...(view.state === 'available' ? {
      state: 'blocked' as const, title: readiness.title,
      description: view.admissionAvailable ? 'You can add requests within the local admission limit while startup completes.' : 'Local admission is full; accepted requests remain queued.',
    } : {}),
  };
}
