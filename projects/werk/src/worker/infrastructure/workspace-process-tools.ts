import type { ModelScope } from '../application/provider-contract.js';
import type { RunJournal } from '../application/journal-ports.js';
import type { ProcessSupervisor } from '../application/process-supervisor.js';
import type { ServiceScope } from '../application/process-supervision.js';
import type { ToolPolicy } from '../application/tool-policy.js';
import { validateFeatureRequestReference } from '../application/feature-request-reference.js';
import type { ProcessObservation } from '../application/process-observation.js';
import { serviceToolOperations } from './service-tools.js';

export interface WorkspaceProcessTools { supervisor(): ProcessSupervisor | undefined; observations: ProcessObservation; }
export function workspaceProcessTools(processes: WorkspaceProcessTools | undefined, scope: ModelScope | undefined, runs?: RunJournal) {
  const featureRequestKey = scope?.feature ? validateFeatureRequestReference(scope.feature).key : undefined;
  const owner = () => {
    const run = scope?.sessionId ? runs?.latest(scope.sessionId) : undefined;
    return { featureRequestKey: featureRequestKey ?? null, sessionId: scope?.sessionId ?? null, taskId: run?.taskId ?? null, runId: run?.id ?? null };
  };
  const serviceScope = (): ServiceScope | undefined => {
    if (!featureRequestKey || !scope?.sessionId || !scope.worktree || !scope.worktreeIdentity) return;
    const current = owner();
    return { featureRequestKey, sessionId: scope.sessionId, worktree: scope.worktree, worktreeIdentity: scope.worktreeIdentity,
      ...(current.taskId ? { taskId: current.taskId } : {}), ...(current.runId ? { runId: current.runId } : {}) };
  };
  return {
    tools: (policy: ToolPolicy) => serviceToolOperations(policy.services, processes?.supervisor(), serviceScope),
    async execute<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      try { return await (processes ? processes.observations.run(owner(), run) : run()); }
      catch (error) { if (featureRequestKey) await processes?.supervisor()?.stopFeature(featureRequestKey, 'feature_ended'); throw error; }
      finally { if (signal?.aborted && featureRequestKey) await processes?.supervisor()?.stopFeature(featureRequestKey, 'feature_ended'); }
    },
  };
}
