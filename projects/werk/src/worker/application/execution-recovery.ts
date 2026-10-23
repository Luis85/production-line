import { object } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import type { WorkerRun } from './run-evidence.js';
import type { WorkerRequest } from './request-gate-contracts.js';
export type UnknownExecutionReason = 'outcome_unknown' | 'process_stop_unconfirmed' | 'worker_restarted';
export interface ExecutionRecovery {
  schemaVersion: 1; revision: number; state: 'unknown' | 'operator_confirmed_stopped'; reason: UnknownExecutionReason; detectedAt: string;
  confirmation?: { operationId: string; note: string; observedAt: string; confirmedAt: string; basis: 'operator_attested' };
}
export interface ExecutionRecoveryCommand { runId: string; expectedRevision: number; operationId: string; note: string; }
export interface ExecutionStopObservation { runId: string; sessionId: string; expectedRevision: number; controllerAbsent: true; ownedProcessesAbsent: true; managedServicesAbsent: true; observedAt: string; }
export function validateExecutionRecoveryCommand(value: unknown): ExecutionRecoveryCommand {
  const raw = object(value, 'Execution recovery', ['action', 'runId', 'expectedRevision', 'operationId', 'note']);
  if (raw.action !== undefined && raw.action !== 'confirm_execution_stopped' || typeof raw.runId !== 'string' || !/^[a-f0-9-]{36}$/.test(raw.runId)
    || !Number.isSafeInteger(raw.expectedRevision) || Number(raw.expectedRevision) < 1 || typeof raw.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(raw.operationId)
    || typeof raw.note !== 'string' || !raw.note.trim() || raw.note.length > 4000) throw new DomainError('invalid_input', 'Confirm the exact unresolved run and revision with an operation ID and an inspection note.');
  return { runId: raw.runId, expectedRevision: Number(raw.expectedRevision), operationId: raw.operationId, note: raw.note.trim() };
}
export function assertExecutionStopObservation(run: WorkerRun, command: ExecutionRecoveryCommand, observation: ExecutionStopObservation): void {
  if (run.executionRecovery?.state !== 'unknown' || run.executionRecovery.revision !== command.expectedRevision) throw new DomainError('conflict', 'Execution uncertainty changed. Reload the exact run before confirming cessation.');
  if (!observation || observation.runId !== run.id || observation.sessionId !== run.sessionId || observation.expectedRevision !== command.expectedRevision
    || observation.controllerAbsent !== true || observation.ownedProcessesAbsent !== true || observation.managedServicesAbsent !== true
    || typeof observation.observedAt !== 'string' || !Number.isFinite(Date.parse(observation.observedAt))) throw new DomainError('conflict', 'Inspect the saved execution and confirm there is no live controller, owned process or managed service before attesting cessation.');
}
/** Delivery worktrees retain their own exact-step reconciliation; never require a second auxiliary attestation. */
export function deliveryOwnsRun(run: WorkerRun, request: WorkerRequest | undefined): boolean {
  return !!request && [request.delivery, ...(request.deliveryHistory ?? [])].some(delivery => delivery?.steps.some(step => step.invocationRunId === run.id || !!run.parentRunId && step.invocationRunId === run.parentRunId));
}
