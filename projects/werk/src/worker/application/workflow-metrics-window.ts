import { DomainError } from '../../shared/errors.js';
import type { WorkflowMetricsQuery } from './workflow-metrics-contracts.js';
export const workflowWeekMs = 7 * 86400000;
export function workflowWeekStart(at: number): number {
  const date = new Date(at); date.setUTCHours(0, 0, 0, 0); date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7); return date.getTime();
}
/** Half-open windows prevent double counting at exact UTC week boundaries; the bound precedes collection. */
export function workflowMetricsWindow(query: WorkflowMetricsQuery, capturedAt: string) {
  const capture = Date.parse(capturedAt), until = Math.min(query.until ? Date.parse(query.until) : capture, capture);
  const lastWeek = workflowWeekStart(until - 1), since = query.since ? Date.parse(query.since) : lastWeek - 103 * workflowWeekMs;
  if (!Number.isFinite(capture) || !Number.isFinite(until) || !Number.isFinite(since) || since > until) throw new DomainError('invalid_input', 'Choose a valid workflow observation window.');
  const count = since === until ? 0 : Math.floor((lastWeek - workflowWeekStart(since)) / workflowWeekMs) + 1;
  if (count > 104) throw new DomainError('invalid_input', 'Workflow observations support at most 104 UTC week buckets. Select a shorter completion window.');
  return { since, until, query: { ...query, since: new Date(since).toISOString(), until: new Date(until).toISOString() } };
}
