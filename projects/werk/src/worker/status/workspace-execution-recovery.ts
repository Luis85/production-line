import { object } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import { serviceActive } from '../application/service-policy.js';
import type { WorkerRun } from '../application/run-evidence.js';
import type { ExecutionStopObservation } from '../application/execution-recovery.js';
import type { WorkspaceContext } from './workspace-context.js';

/** Cessation is an explicit operator attestation, never a provider completion or a retry. */
export async function executionRecoveryCommand(workspace: WorkspaceContext, input: unknown) {
  const body = object(input, 'Execution recovery command', ['action', 'runId', 'expectedRevision', 'operationId', 'note']);
  const runs = workspace.sessions.runs;
  if (body.action === 'execution_recovery') {
    if (Object.keys(body).some(key => key !== 'action')) throw new DomainError('invalid_input', 'Execution recovery inspection accepts only its action.');
    return { schemaVersion: 1 as const, runs: runs.uncertainExecutions() };
  }
  if (body.action !== 'confirm_execution_stopped') throw new DomainError('invalid_input', 'Choose execution_recovery or confirm_execution_stopped.');
  const { action: _action, ...command } = body;
  // A lost acknowledgement replays the same decision even if later work has started.
  const replay = runs.recoveryReplay(command);
  if (replay) return { schemaVersion: 1 as const, run: replay, duplicate: true };
  const run = runs.get(command.runId as string);
  if (run.executionRecovery?.state !== 'unknown' || run.executionRecovery.revision !== command.expectedRevision)
    throw new DomainError('conflict', 'This execution recovery changed. Refresh its retained evidence before confirming.');
  const ownerSessions = new Set([run.sessionId, ...(run.parentSessionId ? [run.parentSessionId] : [])]);
  const ownerRuns = new Set([run.id, ...(run.parentRunId ? [run.parentRunId] : [])]);
  const delegatedOwner = (evidence: WorkerRun | undefined) => !!evidence?.parentRunId && !!evidence.parentSessionId && ownerRuns.has(evidence.parentRunId) && ownerSessions.has(evidence.parentSessionId);
  const relatedExecution = (sessionId: string | null, runId: string | null = null): boolean => {
    if (sessionId !== null && ownerSessions.has(sessionId) || runId !== null && ownerRuns.has(runId)) return true;
    let evidence: WorkerRun | undefined;
    if (runId !== null) {
      try { evidence = runs.get(runId); }
      catch (error) { if (!(error instanceof DomainError) || !['invalid_input', 'not_found'].includes(error.code)) throw error; }
    }
    return delegatedOwner(evidence) || sessionId !== null && delegatedOwner(runs.latest(sessionId));
  };
  const assertNoLiveOwner = () => {
    if (!workspace.acceptingTasks) throw new DomainError('unavailable', 'Worker is stopping.');
    if ([...ownerSessions].some(sessionId => workspace.executor.has(sessionId)) || workspace.executor.executions.some(execution => relatedExecution(execution.sessionId)))
      throw new DomainError('conflict', 'This execution still has a live controller. Stop it and wait before confirming.');
    if (workspace.processes?.status().services.some(service => serviceActive(service.state) && relatedExecution(service.sessionId)))
      throw new DomainError('conflict', 'Stop this execution’s managed development services before confirming.');
  };
  assertNoLiveOwner();
  const processes = await workspace.processObservations.status();
  // Recheck synchronous ownership after the last asynchronous observation.
  assertNoLiveOwner();
  if (processes.processes.some(process => process.state === 'running' && relatedExecution(process.sessionId, process.runId)))
    throw new DomainError('conflict', 'An owned process for this execution is still running. Stop it before confirming.');
  const observation: ExecutionStopObservation = {
    runId: run.id, sessionId: run.sessionId, expectedRevision: run.executionRecovery.revision,
    controllerAbsent: true, ownedProcessesAbsent: true, managedServicesAbsent: true, observedAt: new Date().toISOString(),
  };
  const confirmed = runs.confirmExecutionStopped(command, observation);
  workspace.executor.wake();
  return { schemaVersion: 1 as const, run: confirmed, duplicate: false };
}
