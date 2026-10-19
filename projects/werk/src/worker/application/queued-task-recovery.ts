import { createHash } from 'node:crypto';
import type { LocalTask } from './local-task-contracts.js';
import type { RequestJournal, InteractionJournal, RunJournal } from './journal-ports.js';
import type { SessionRecord } from './session-catalog.js';
import { gateInput, taskContext } from './local-task-preparation.js';
import { gateDigest, validateGateInput, validateGatePolicy, type WorkerRequest } from './request-gates.js';
import { requireModelRequest } from './model-contract.js';

type Evidence = { requests: RequestJournal; interactions: InteractionJournal; runs: RunJournal };
type PreparedTask = LocalTask & Required<Pick<LocalTask, 'requestId' | 'currentTurnId' | 'runId' | 'feature'>>;
type LocalRecord = Pick<SessionRecord, 'id' | 'kind' | 'taskId' | 'feature' | 'provider' | 'taskState' | 'archived' | 'continuationBlockedReason'>;

function queuedTask(task: LocalTask): task is PreparedTask {
  return !!task && task.status === 'queued' && !task.archived && !task.admissionFailure &&
    task.finishedAt === null && task.error === null && task.summary === null && task.patch === null &&
    !!task.requestId && !!task.currentTurnId && !!task.runId && !!task.feature &&
    task.sessionId === 'local-' + task.id && task.developmentCompletion?.turnId !== task.currentTurnId;
}

function preparedRequest(task: PreparedTask, evidence: Evidence): WorkerRequest | undefined {
  const request = evidence.requests.get(task.requestId), execution = request.execution;
  if (request.id !== task.requestId || request.owner.sessionId !== task.sessionId || request.owner.rootTurnId !== task.id ||
      request.owner.taskId !== task.id || request.owner.featureId !== task.feature.key || request.owner.remote ||
      request.input.kind !== 'patch' || request.provider.model !== task.model || (request.provider.effort ?? 'default') !== (task.selection?.effort ?? 'default') || ![task.provider, 'legacy'].includes(request.provider.id) ||
      request.phase !== 'ready' || request.recoveryHold) return;
  if (!execution || execution.status !== 'prepared' || execution.turnId !== task.currentTurnId || execution.runId !== task.runId ||
      execution.inputRevision !== request.inputRevision || execution.result !== null || execution.outcome !== null ||
      execution.outputDigest !== null || Object.keys(execution.facts).length) return;
  if (evidence.requests.forTurn(task.sessionId, task.currentTurnId)?.id !== request.id ||
      gateDigest(evidence.requests.execution(request.id, task.currentTurnId)) !== gateDigest(execution)) return;
  const expectedInput = validateGateInput(gateInput({ context: taskContext }, task));
  if (request.inputHash !== gateDigest(validateGateInput(request.input)) || request.inputHash !== gateDigest(expectedInput) ||
      request.policyDigest !== gateDigest(validateGatePolicy(request.policy))) return;
  const ready = request.evaluations.findLast(e => e.stage === 'ready' && e.inputRevision === request.inputRevision);
  if (!ready?.passed || ready.inputHash !== request.inputHash || ready.policyDigest !== request.policyDigest) return;
  return request;
}

function preparedTurn(task: PreparedTask, evidence: Evidence, request: WorkerRequest, record: LocalRecord): boolean {
  const view = evidence.interactions.view(task.sessionId), turn = evidence.interactions.turn(task.sessionId, task.currentTurnId);
  if (view.phase !== 'queued' || view.pending || view.latestTurn?.id !== turn.id || turn.id !== task.currentTurnId ||
      turn.sessionId !== task.sessionId || turn.status !== 'queued' || turn.runId !== task.runId || turn.finishedAt !== null ||
      turn.result !== null || turn.usage !== null || turn.errorCode !== null || turn.toolBudget) return false;
  // A crash can leave the prior terminal projection after an explicit answer/resume was saved.
  if (record.taskState && record.taskState !== 'queued') {
    if (!turn.priorTurnId) return false;
    const prior = evidence.interactions.turn(task.sessionId, turn.priorTurnId);
    const priorState = prior.status === 'interrupted' ? 'failed' : prior.status;
    if (record.taskState !== priorState) return false;
  }
  if (!turn.dispatch || turn.dispatch.operation !== 'patch' || gateDigest(turn.context) !== gateDigest(taskContext(task)) ||
      gateDigest(turn.dispatch.provider) !== gateDigest(request.provider)) return false;
  requireModelRequest(turn.dispatch, request.provider.id);
  return turn.dispatchDigest === createHash('sha256').update(JSON.stringify(turn.dispatch)).digest('hex');
}

function queuedRun(task: PreparedTask, evidence: Evidence): boolean {
  const run = evidence.runs.get(task.runId);
  return run.id === task.runId && run.sessionId === task.sessionId && run.taskId === task.id && run.requestId === task.requestId &&
    run.kind === 'local' && run.purpose === 'execution' && run.provider === task.provider && run.model === task.model &&
    run.outcome === 'queued' && run.before === null && run.after === null && run.startedAt === null &&
    run.durationMs === null && run.queueDurationMs === null && run.resourceDelta.cpuUserMicros === null && run.resourceDelta.cpuSystemMicros === null &&
    run.usage.source === 'unavailable' && run.usage.providerReportedCostUsd === null && run.usage.inputTokens === null &&
    run.usage.outputTokens === null && run.usage.cacheReadTokens === null && run.usage.cacheWriteTokens === null;
}

/** Missing usage never proves a call did not happen: every durable start fence must agree. */
export function isPreparedLocalTask(task: LocalTask, evidence: Evidence, records: readonly LocalRecord[]): boolean {
  try {
    if (!queuedTask(task)) return false;
    const record = records.find(record => record.id === task.sessionId);
    if (!record || record.kind !== 'local' || record.taskId !== task.sessionId || record.provider !== task.provider ||
        record.taskState === 'running' || record.archived || record.continuationBlockedReason || record.feature?.key !== task.feature.key) return false;
    const request = preparedRequest(task, evidence);
    return !!request && preparedTurn(task, evidence, request, record) && queuedRun(task, evidence);
  } catch { return false; }
}
