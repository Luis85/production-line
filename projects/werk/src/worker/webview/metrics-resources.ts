import type { ResourceAlertCode, ResourceStatus } from '../application/resources';

export interface ResourceMetric {
  id: Exclude<ResourceAlertCode, 'long_running'>;
  label: string;
  value: number | null;
  capacity: number | null;
  percent: number | null;
  thresholdPercent: number | null;
  warning: boolean;
}
const ratio = (value: number | null | undefined, capacity: number | null | undefined) =>
  value != null && Number.isFinite(value) && value >= 0 && capacity != null && Number.isFinite(capacity) && capacity > 0
    ? value / capacity * 100 : null;

/** Keep measured percentages intact; only the decorative meter is capped by its HTML range. */
export function resourceMetrics(report: ResourceStatus | null): ResourceMetric[] {
  const snapshot = report?.snapshot;
  const metric = (id: ResourceMetric['id'], label: string, value: number | null, capacity: number | null, percent: number | null, thresholdPercent: number | null): ResourceMetric =>
    ({ id, label, value, capacity, percent, thresholdPercent, warning: !!report?.alerts.some(alert => alert.code === id) });
  const diskCapacity = snapshot?.diskTotalBytes ?? null;
  const diskThreshold = report && diskCapacity && diskCapacity > 0
    ? Math.max(report.policy.diskFreePercent, report.policy.diskFreeBytes / diskCapacity * 100) : null;
  return [
    metric('cpu', 'Worker CPU usage', snapshot?.cpuPercent ?? null, snapshot?.cpuCapacityCores ?? null, snapshot?.cpuPercent ?? null, report?.policy.cpuPercent ?? null),
    metric('memory', 'Worker resident memory', snapshot?.rssBytes ?? null, snapshot?.effectiveMemoryLimitBytes ?? null, ratio(snapshot?.rssBytes, snapshot?.effectiveMemoryLimitBytes), report?.policy.memoryPercent ?? null),
    metric('heap', 'Worker heap', snapshot?.heapUsedBytes ?? null, snapshot?.heapLimitBytes ?? null, ratio(snapshot?.heapUsedBytes, snapshot?.heapLimitBytes), report?.policy.heapPercent ?? null),
    metric('disk', 'State-volume space available', snapshot?.diskAvailableBytes ?? null, diskCapacity, ratio(snapshot?.diskAvailableBytes, diskCapacity), diskThreshold),
  ];
}

export function measurementStale(capturedAt: string | null | undefined, intervalMs: number, now: number): boolean {
  const captured = capturedAt ? Date.parse(capturedAt) : NaN;
  return !Number.isFinite(captured) || now - captured > Math.max(30000, intervalMs * 3);
}

export function resourceSampleState(report: ResourceStatus | null, now: number, paused: boolean, readError: string) {
  const unavailable = !report?.snapshot;
  const stale = paused || !!readError || !!report?.sampleError || measurementStale(report?.snapshot?.capturedAt, report?.sampleIntervalMs ?? 10000, now);
  const label = unavailable ? 'No sample yet' : stale ? 'Last reported sample' : 'Current sample';
  let message = '';
  if (readError) message = 'Resource measurements could not be refreshed. Last reported values are kept; refresh to try again.';
  else if (paused) message = 'Live updates are paused. These are the last reported measurements.';
  else if (report?.sampleError) message = 'Some measurements could not be refreshed. Available values may be stale.';
  else if (!unavailable && stale) message = 'This resource sample is older than expected. Last reported values are kept; refresh to try again.';
  return { unavailable, stale, label, message };
}
