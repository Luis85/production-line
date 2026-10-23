import type { DeliveryMetricObservation, DeliveryMetricsReport } from './delivery-metrics-contracts.js';
import type { DeliveryMetricTimelineEvent } from './delivery-metrics-contracts.js';
type Question = Extract<DeliveryMetricObservation, { kind: 'clarification' }>;
/** An asked round is complete only when every recorded question has an explicit matching answer. */
export function addDeliveryClarification(report: DeliveryMetricsReport['clarification'], events: readonly DeliveryMetricTimelineEvent[], measuredHistory: boolean, profileId: string) {
  const observations = events.flatMap(event => event.measurement?.observations ?? []);
  const questions = new Map<string, Question>(), answers = new Set<string>();
  const revisions = new Map(events.flatMap(event => (event.measurement?.observations ?? []).filter(item => item.kind === 'clarification').map(item => [item.questionId, event.inputRevision] as const)));
  const current = events.at(-1);
  const key = (item: { cycleId: string; questionId: string; cause: string }) => JSON.stringify([item.cycleId, item.questionId, item.cause]);
  for (const item of observations) {
    if (item.kind === 'clarification') questions.set(key(item), item);
    if (item.kind === 'clarification_answer') answers.add(key(item));
  }
  const rounds = new Map<string, Question[]>();
  for (const question of questions.values()) rounds.set(question.cycleId, [...(rounds.get(question.cycleId) ?? []), question]);
  const unmeasuredQuestions = events.some(event => event.type === 'input_requested' && !event.measurement?.observations?.some(item => item.kind === 'clarification'));
  if (measuredHistory && !unmeasuredQuestions || rounds.size) report.observedRequests++; else report.unknownRequests++;
  let unknown = 0;
  for (const round of rounds.values()) {
    const outstanding = round.filter(question => !answers.has(key(question)));
    const outcome = !outstanding.length ? 'completedCycles' : measuredHistory && current && !['done', 'cancelled'].includes(current.phase) && outstanding.every(question => question.answerTracking === true && revisions.get(question.questionId) === current.inputRevision) ? 'pendingCycles' : 'unknownCycles';
    report.cycles++; report[outcome]++; if (outcome === 'unknownCycles') unknown++;
    for (const cause of new Set(round.map(question => question.cause))) {
      let group = report.groups.find(item => item.profileId === profileId && item.cause === cause);
      if (!group) { group = { profileId, cause, cycles: 0, completedCycles: 0, pendingCycles: 0, unknownCycles: 0 }; report.groups.push(group); }
      group.cycles++; group[outcome]++;
    }
  }
  if (measuredHistory && !unmeasuredQuestions && !unknown) report.completionMeasuredRequests++; else report.unknownCompletionRequests++;
}
