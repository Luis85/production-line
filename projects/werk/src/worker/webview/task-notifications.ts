import type { TaskOverviewItem } from './task-overview';
export interface TaskNotification { id: string; taskId: string; title: string; message: string; href: string; }
const fingerprint = (item: TaskOverviewItem) => [item.status, item.group, item.deliveryPhaseLabel, item.nextEvent].join('\n');
/** Poll timestamps do not notify; only a new request or meaningful retained-state transition does. */
export function taskActivityChanges(previous: readonly TaskOverviewItem[], current: readonly TaskOverviewItem[]): TaskNotification[] {
  const before = new Map(previous.map(item => [item.id, fingerprint(item)]));
  return current.filter(item => (item.requestId || item.deliveryRunId) && before.get(item.id) !== fingerprint(item)).map(item => ({
    id: [item.id, item.updatedAt, fingerprint(item)].join(':'), taskId: item.taskId, title: item.title,
    message: item.deliveryPhaseLabel ? item.deliveryPhaseLabel + ' · ' + item.statusLabel : item.statusLabel,
    href: item.primaryAction.kind === 'review' ? item.primaryAction.href : item.evidenceHref,
  }));
}
