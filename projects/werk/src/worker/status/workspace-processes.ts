import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { object, identifier } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import type { ServiceScope, ServiceRecord } from '../application/process-supervision.js';
import type { WorkerProcessesView, ServiceRecordView } from '../application/process-observation.js';
import { createProcessSupervisor } from '../infrastructure/process-supervisor.js';
import type { WorkspaceContext } from './workspace-context.js';

const invalid = () => new DomainError('conflict', 'This Feature Request no longer owns an eligible pinned worktree.');
function currentProcessTask(workspace: WorkspaceContext, scope: ServiceScope) {
  if (!workspace.acceptingTasks) throw invalid();
  const task = workspace.board.view().tasks.find(item => item.id === scope.taskId && item.sessionId === scope.sessionId);
  const session = workspace.sessions.view().records.find(item => item.id === scope.sessionId);
  if (!task || !session || task.feature?.key !== scope.featureRequestKey || session.feature?.key !== scope.featureRequestKey
    || task.archived || session.archived || task.admissionFailure || !task.baseCommit || !task.worktreeKey
    || ['failed', 'cancelled', 'interrupted', 'needs_rework'].includes(task.status) || ['failed', 'cancelled', 'interrupted'].includes(session.status)
    || task.worktree !== scope.worktree || !task.worktreeIdentity || (['dev', 'ino', 'birthtimeMs'] as const).some(key => task.worktreeIdentity![key] !== scope.worktreeIdentity[key])) throw invalid();
  if (task.repositoryId && !workspace.settings.value.repositories.items.some(item => item.id === task.repositoryId && item.path === task.repository)) throw invalid();
  return task;
}
async function validateProcessScope(workspace: WorkspaceContext, scope: ServiceScope): Promise<void> {
  const task = currentProcessTask(workspace, scope);
  await workspace.repositoryDiscovery.assertAllowed(task.repository);
  try {
    const info = await lstat(scope.worktree);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(scope.worktree) !== resolve(scope.worktree)
      || String(info.dev) !== scope.worktreeIdentity.dev || String(info.ino) !== scope.worktreeIdentity.ino || info.birthtimeMs !== scope.worktreeIdentity.birthtimeMs) throw invalid();
  } catch { throw invalid(); }
  currentProcessTask(workspace, scope);
}
export async function initProcesses(workspace: WorkspaceContext) {
  workspace.processes = await createProcessSupervisor({ directory: workspace.config.stateDir,
    presets: () => { const policy = workspace.settings.toolPolicy().services; return policy?.enabled ? policy.presets : []; },
    maxActive: () => workspace.settings.toolPolicy().services?.maxActive ?? 4,
    validateScope: scope => validateProcessScope(workspace, scope),
  });
  // Reconcile failures, archived requests and externally changed worktrees even when the UI is closed.
  workspace.processReconciliation = setInterval(() => { void workspace.processes?.reconcileGrants().catch(() => {}); }, 1000);
  workspace.processReconciliation.unref();
}
export async function closeProcesses(workspace: WorkspaceContext) {
  if (workspace.processReconciliation) clearInterval(workspace.processReconciliation);
  workspace.processReconciliation = undefined;
  await workspace.processes?.close();
}
async function projectService(workspace: WorkspaceContext, record: ServiceRecord): Promise<ServiceRecordView> {
  const controls = await workspace.processes!.controls(record.id);
  const current = workspace.processes!.status().services.find(item => item.id === record.id);
  return { ...(current ?? record), controls: current?.revision === record.revision ? controls : { stop: false, restart: false, restartUnavailableReason: 'The service changed while reading its controls. Refresh before acting.' } };
}
export async function processStatus(workspace: WorkspaceContext): Promise<WorkerProcessesView> {
  if (!workspace.processes) throw new DomainError('unavailable', 'Process supervision is not initialized.');
  const services = workspace.processes.status();
  const executions = await workspace.processObservations.status();
  return { schemaVersion: 1, capturedAt: new Date().toISOString(), services: { ...services, services: await Promise.all(services.services.map(record => projectService(workspace, record))) }, executions };
}
export async function processCommand(workspace: WorkspaceContext, input: unknown) {
  const body = object(input, 'Process command', ['action', 'id', 'expectedRevision', 'operationId', 'after', 'limit']);
  if (body.action === 'status' && Object.keys(body).length === 1) return processStatus(workspace);
  const id = identifier(body.id, 'service ID');
  const supervisor = workspace.processes;
  if (!supervisor) throw new DomainError('unavailable', 'Process supervision is not initialized.');
  if (body.action === 'logs' && body.expectedRevision === undefined && body.operationId === undefined) {
    for (const [key, maximum, minimum] of [['after', Number.MAX_SAFE_INTEGER, 0], ['limit', 128, 1]] as const) if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || Number(body[key]) < minimum || Number(body[key]) > maximum)) throw new DomainError('invalid_input', 'Use a nonnegative log cursor and a limit from 1 to 128.');
    const record = supervisor.status().services.find(item => item.id === id);
    if (!record) throw new DomainError('not_found', 'This service is not retained by the worker.');
    return { id, revision: record.revision, ...supervisor.logs(id, { after: body.after as number | undefined, limit: body.limit as number | undefined }) };
  }
  if (!['stop', 'restart'].includes(String(body.action)) || body.after !== undefined || body.limit !== undefined || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) throw new DomainError('invalid_input', 'Use stop or restart with the current service revision and a unique operation ID.');
  const command = { id, expectedRevision: Number(body.expectedRevision), operationId: identifier(body.operationId, 'operation ID') };
  const record = body.action === 'stop' ? await supervisor.stop(command) : await supervisor.restart(command);
  return { service: await projectService(workspace, record) };
}
export async function stopSessionProcesses(workspace: WorkspaceContext, sessionId: string) {
  const reference = workspace.sessions.view().records.find(item => item.id === sessionId)?.feature;
  if (reference) await workspace.processes?.stopFeature(reference.key, 'feature_ended');
}
