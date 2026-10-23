import { DomainError } from '../../shared/errors.js';
import { gateDigest } from './request-gates.js';
import { validateFeatureRequestReference, type FeatureRequestReference } from './feature-request-reference.js';
import type { DeliveryBlockerCategory, DeliveryMetricObservation } from './delivery-metrics-contracts.js';

export interface FeatureIntakeMeasurementEvent {
  id: string; at: string; state: string; inputRevision: string;
  phase: 'readiness' | 'waiting_input' | 'queued' | 'cancelled'; feedback?: true;
  blockers: { code: string; category: DeliveryBlockerCategory }[];
  observations?: DeliveryMetricObservation[]; providerRunId?: string;
  providerIntervals?: { startedAt: string; finishedAt: string | null }[];
}
export interface FeatureIntakeMeasurement {
  feature: FeatureRequestReference; projectId: string | null; profileId: string | null;
  submittedAt: string | null; observedAt: string; complete: boolean; sessionId?: string;
  events: FeatureIntakeMeasurementEvent[];
}
export interface FeatureIntakeMeasurementStore { measurements?: FeatureIntakeMeasurement[]; }
export type FeatureIntakeMeasurementUpdate = Omit<FeatureIntakeMeasurementEvent, 'id' | 'at' | 'state'>;
const categories = new Set(['requirements', 'environment', 'permissions', 'provider', 'dependency', 'budget', 'operator', 'unknown']);
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const atom = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);
const observationKey = (value: DeliveryMetricObservation) => gateDigest(value);
const stateOf = ({ observations: _observations, ...value }: FeatureIntakeMeasurementUpdate) => gateDigest(value);
/** Typed failure classification is independent of user-facing prose and never controls admission. */
export class FeatureIntakeBlocked extends DomainError {
  readonly intakeBlocker: { code: string; category: DeliveryBlockerCategory };
  constructor(error: unknown, code: string, category: DeliveryBlockerCategory) {
    super(error instanceof DomainError ? error.code : 'unavailable', error instanceof Error ? error.message : 'Feature intake cannot proceed.');
    this.intakeBlocker = { code, category };
  }
}
export function featureIntakeBlocker(error: unknown): { code: string; category: DeliveryBlockerCategory } {
  return error instanceof FeatureIntakeBlocked ? { ...error.intakeBlocker } : { code: 'intake_unavailable', category: 'unknown' };
}
export function featureIntakeHold(code: string): { code: string; category: DeliveryBlockerCategory } {
  return { code, category: code === 'budget' ? 'budget' : ['paused', 'capacity', 'stopping'].includes(code) ? 'operator' : 'environment' };
}
/** The first stable ready observation is the worker's submission observation, not the author's creation time. */
export function observeFeatureIntake(store: FeatureIntakeMeasurementStore, feature: FeatureRequestReference, inputRevision: string,
  metadata: { projectId?: string | null; profileId?: string | null; sessionId?: string; historical?: boolean } = {}, now = new Date().toISOString()) {
  const rows = store.measurements ??= [];
  let measurement = rows.find(row => row.feature.key === feature.key);
  if (!measurement) {
    if (rows.length >= 4096) throw new DomainError('conflict', 'The retained intake measurement history reached its limit. Preserve and rotate this worker state before accepting more request identities.');
    measurement = { feature: structuredClone(feature), projectId: metadata.projectId ?? feature.repositoryId ?? null, profileId: metadata.profileId ?? null,
      submittedAt: metadata.historical ? null : now, observedAt: now, complete: !metadata.historical, events: [] };
    rows.push(measurement);
    appendFeatureIntake(measurement, { inputRevision, phase: 'readiness', blockers: [] }, now);
  }
  if (metadata.projectId) measurement.projectId = metadata.projectId;
  if (metadata.profileId) measurement.profileId = metadata.profileId;
  if (metadata.sessionId) measurement.sessionId = metadata.sessionId;
  return measurement;
}
/** Repeated polling emits no events. A bounded history explicitly loses complete coverage instead of claiming zero waits. */
export function appendFeatureIntake(measurement: FeatureIntakeMeasurement, update: FeatureIntakeMeasurementUpdate, now = new Date().toISOString()) {
  const seen = new Set(measurement.events.flatMap(event => event.observations ?? []).map(observationKey));
  const observations = update.observations?.filter(value => !seen.has(observationKey(value)));
  const snapshot = structuredClone({ ...update, blockers: [...update.blockers].sort((a,b) => a.code.localeCompare(b.code)), ...(observations?.length ? { observations } : {}) });
  if (!observations?.length) delete snapshot.observations;
  const state = stateOf(snapshot);
  if (measurement.events.at(-1)?.state === state && !observations?.length) return;
  if (measurement.events.length >= 256 || Buffer.byteLength(JSON.stringify(measurement)) > 65536) { measurement.complete = false; return; }
  const event: FeatureIntakeMeasurementEvent = { ...snapshot, at: now, state, id: 'intake-event-' + gateDigest([measurement.feature.key, measurement.events.length, now, state, observations ?? []]) };
  measurement.events.push(event); measurement.observedAt = now;
}
/** Only successful revalidation resolves deterministic intake findings; a changed source alone is insufficient. */
export function featureIntakeReadiness(measurement: FeatureIntakeMeasurement, inputRevision: string, issues?: readonly { code: string }[]) {
  const cycleId = 'intake-ready-' + inputRevision;
  if (issues?.length) return issues.slice(0, 16).map((issue, index): DeliveryMetricObservation => ({ kind: 'clarification', cycleId,
    questionId: cycleId + ':' + gateDigest([issue.code, index]).slice(0, 16), cause: 'readiness', answerTracking: true }));
  const observations = measurement.events.flatMap(event => event.observations ?? []);
  const answered = new Set(observations.filter(item => item.kind === 'clarification_answer').map(item => item.questionId));
  return observations.filter((item): item is Extract<DeliveryMetricObservation, { kind: 'clarification' }> => item.kind === 'clarification' && item.cycleId.startsWith('intake-ready-') && !answered.has(item.questionId))
    .map((item): DeliveryMetricObservation => ({ kind: 'clarification_answer', questionId: item.questionId, cycleId: item.cycleId, cause: item.cause }));
}
/** Journal readers validate telemetry separately from workflow authority; it can never introduce an execution. */
export function validateFeatureIntakeMeasurements(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 4096) throw Error('Invalid intake measurement history.');
  const keys = new Set<string>();
  for (const raw of value) {
    const row = raw as FeatureIntakeMeasurement;
    if (!row || !row.feature) throw Error('Invalid intake measurement identity.');
    const feature = validateFeatureRequestReference(row.feature);
    if (keys.has(feature.key) || row.submittedAt !== null && !validDate(row.submittedAt) || !validDate(row.observedAt) || typeof row.complete !== 'boolean'
      || row.complete && row.submittedAt === null || row.projectId !== null && !atom(row.projectId) || row.profileId !== null && !atom(row.profileId)
      || row.sessionId !== undefined && !atom(row.sessionId) || !Array.isArray(row.events) || row.events.length > 256) throw Error('Invalid intake measurement metadata.');
    keys.add(feature.key); const ids = new Set<string>(); let previous = -Infinity;
    for (const event of row.events) {
      if (!event || !atom(event.id) || ids.has(event.id) || !validDate(event.at) || Date.parse(event.at) < previous || !atom(event.inputRevision)
        || !['readiness', 'waiting_input', 'queued', 'cancelled'].includes(event.phase) || event.feedback !== undefined && event.feedback !== true
        || !Array.isArray(event.blockers) || event.blockers.length > 32 || event.blockers.some(blocker => !atom(blocker.code) || !categories.has(blocker.category))
        || event.providerRunId !== undefined && !atom(event.providerRunId) || event.providerIntervals !== undefined && (!Array.isArray(event.providerIntervals) || event.providerIntervals.length > 32 || event.providerIntervals.some(interval => !validDate(interval.startedAt) || interval.finishedAt !== null && (!validDate(interval.finishedAt) || interval.finishedAt < interval.startedAt)))) throw Error('Invalid intake measurement event.');
      const { id: _id, at: _at, state, ...update } = event;
      if (state !== stateOf(update)) throw Error('Intake measurement state digest differs.');
      if (event.observations !== undefined && (!Array.isArray(event.observations) || event.observations.length > 32 || event.observations.some(item => !item || !['clarification', 'clarification_answer'].includes(item.kind)
        || !('questionId' in item) || !atom(item.questionId) || !atom(item.cycleId) || !atom(item.cause) || item.kind === 'clarification' && item.answerTracking !== undefined && item.answerTracking !== true))) throw Error('Invalid intake clarification observation.');
      ids.add(event.id); previous = Date.parse(event.at);
    }
  }
}
