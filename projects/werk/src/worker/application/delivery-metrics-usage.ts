import type { FeatureIntakeMeasurement } from './feature-intake-measurement.js';
import { findDeliveryMetricIntake, deliveryIntakeRunIds } from './delivery-metric-intake.js';
import { deliveryMetricCalls } from './delivery-metric-evidence.js';
import type { RequestEvent, WorkerRequest } from './request-gates.js';
import type { WorkerRun } from './run-evidence.js';
import type { DeliveryMetricsReport } from './delivery-metrics-contracts.js';
const valid = (value: number | null) => value !== null && Number.isFinite(value) && value >= 0;
export function deliveryConsumptionMetrics(requests: readonly WorkerRequest[], events: readonly RequestEvent[], runs: readonly WorkerRun[], until: number, intake: readonly FeatureIntakeMeasurement[] = []): DeliveryMetricsReport['consumption'] {
  const result: DeliveryMetricsReport['consumption'] = { acceptedRequests: 0, measuredRequests: 0, partialRequests: 0, inputTokens: null, outputTokens: null, costUsd: null, costMeasuredRequests: 0, meanTokens: null, sources: [], costBases: [] };
  const sources = new Set<string>(), bases = new Set<string>();
  let completeTokens = 0;
  for (const request of requests) {
    const timeline = events.filter(event => event.requestId === request.id && Date.parse(event.at) <= until).sort((a,b) => a.sequence - b.sequence);
    const latest = timeline.at(-1);
    const currentAccepted = latest ? latest.phase === 'done' : request.phase === 'done' && Date.parse(request.updatedAt) <= until;
    const accepted = currentAccepted && (events.some(event => event.requestId === request.id && event.type === 'operator_attested' && (event.measurement?.lifecycle === 'done' || event.phase === 'done') && Date.parse(event.at) <= until)
      || request.lifecycle === 'done' && !!request.attestation && Date.parse(request.attestation.at) <= until);
    if (!accepted) continue;
    result.acceptedRequests++;
    const source = findDeliveryMetricIntake(request, intake);
    const { calls, complete: linked } = deliveryMetricCalls(request, timeline, runs, until, deliveryIntakeRunIds(source, until));
    const fullHistory = !source || source.complete;
    const roots = calls.filter(run => !run.parentRunId);
    const complete = fullHistory && linked && roots.length > 0 && calls.length === roots.length && roots.every(run => !!run.after && Date.parse(run.after.capturedAt) <= until && valid(run.usage.inputTokens) && valid(run.usage.outputTokens));
    const finished = roots.filter(run => !!run.after && Date.parse(run.after.capturedAt) <= until);
    if (complete) { result.measuredRequests++; completeTokens += finished.reduce((sum, run) => sum + run.usage.inputTokens! + run.usage.outputTokens!, 0); }
    else if (finished.some(run => valid(run.usage.inputTokens) || valid(run.usage.outputTokens))) result.partialRequests++;
    if (fullHistory && linked && roots.length > 0 && roots.length === calls.length && finished.length === roots.length && roots.every(run => valid(run.usage.providerReportedCostUsd))) result.costMeasuredRequests++;
    for (const run of finished) {
      const usage = run.usage; sources.add(usage.source); bases.add(usage.costBasis ?? 'unknown');
      if (valid(usage.inputTokens)) result.inputTokens = (result.inputTokens ?? 0) + usage.inputTokens!;
      if (valid(usage.outputTokens)) result.outputTokens = (result.outputTokens ?? 0) + usage.outputTokens!;
      if (valid(usage.providerReportedCostUsd)) result.costUsd = (result.costUsd ?? 0) + usage.providerReportedCostUsd!;
    }
  }
  result.meanTokens = result.measuredRequests ? completeTokens / result.measuredRequests : null;
  result.sources = [...sources].sort(); result.costBases = [...bases].sort();
  return result;
}
