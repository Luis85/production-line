import type { RunAnalysis, RunQuery } from '../application/run-evidence';

export type ExecutionWindow = '24h' | '7d' | '30d' | 'all';
export interface ExecutionSnapshot {
  analysis: RunAnalysis;
  window: ExecutionWindow;
  interval: Pick<RunQuery, 'since'> & { until: string };
}
export const executionWindows: { value: ExecutionWindow; label: string }[] = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All retained attempts' },
];

/** The API filters acceptance time. Capture both bounds before beginning a request. */
export function executionInterval(window: ExecutionWindow, now: number): Pick<RunQuery, 'since'> & { until: string } {
  const days = window === '24h' ? 1 : window === '7d' ? 7 : 30;
  return { ...(window === 'all' ? {} : { since: new Date(now - days * 86_400_000).toISOString() }), until: new Date(now).toISOString() };
}

const outcomes = [
  ['completed', 'Completed', 'positive'], ['review', 'Patch ready for review', 'review'],
  ['running', 'Running', 'active'], ['queued', 'Queued', 'neutral'],
  ['waiting_input', 'Waiting for input', 'waiting'], ['escalated', 'Escalated', 'waiting'],
  ['failed', 'Failed', 'negative'], ['cancelled', 'Cancelled', 'neutral'],
  ['interrupted', 'Interrupted', 'negative'],
] as const;

export function executionOutcomes(analysis: Pick<RunAnalysis, 'total' | 'outcomes'>) {
  const known = new Set<string>(outcomes.map(([key]) => key));
  const entries = [
    ...outcomes.map(([key, label, tone]) => ({ key, label, tone, count: analysis.outcomes[key] ?? 0 })),
    ...Object.entries(analysis.outcomes).filter(([key]) => !known.has(key)).map(([key, count]) => ({ key, label: key.replaceAll('_', ' '), tone: 'neutral', count })),
  ];
  return entries.map(entry => ({ ...entry, percent: analysis.total > 0 ? entry.count / analysis.total * 100 : 0 }));
}

export const reportedCount = (value: number | null | undefined) => value == null ? 'Not reported' : value.toLocaleString();
export const reportedCost = (value: number | null | undefined) => value == null ? 'Not reported' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
export function measuredDuration(value: number | null | undefined) {
  if (value == null) return 'Not measured';
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min ${seconds % 60} s` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
