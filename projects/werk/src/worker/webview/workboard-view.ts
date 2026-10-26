import type { TaskOverviewItem } from './task-overview';
export type WorkboardLane = 'queued' | 'running' | 'review' | 'attention' | 'completed' | 'draft';
/** Presentation only: lifecycle and actions remain those of the authoritative request projection. */
export function workboardLane(item: TaskOverviewItem): WorkboardLane {
  if (item.deliveryRunId && ['running', 'pause_pending', 'interrupting', 'reconciling'].includes(item.status)) return 'running';
  if (item.group === 'attention' && item.primaryAction.kind === 'review' &&
    (['review', 'done'].includes(item.status) || /awaiting.*(merge|release|integration)|ready for review/i.test(item.statusLabel))) return 'review';
  return item.group;
}
export function workboardAction(item: TaskOverviewItem): TaskOverviewItem {
  if (item.primaryAction.kind === 'feature' && item.projectId) {
    const query = new URLSearchParams({ project: item.projectId, ...(item.featureName ? { request: item.featureName } : {}) });
    return { ...item, primaryAction: { ...item.primaryAction, href: '/projects?' + query + '#shared-progress' } };
  }
  if (item.primaryAction.kind !== 'review') return item;
  return { ...item, ...(item.deliveryRunId ? { sourceLabel: 'Feature Request' } : {}), primaryAction: { ...item.primaryAction, label: workboardLane(item) === 'review' ? 'Review increment' : 'Open progress' } };
}
