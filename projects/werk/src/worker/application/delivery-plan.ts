import type { DeliveryDependencyReceipt } from './delivery-dependencies.js';
import type { DeliveryRun } from './delivery-contracts.js';
import type { LocalTask } from './local-task-contracts.js';
import type { WorkerRequest } from './request-gate-contracts.js';
import type { ModelRequest } from './model-contract.js';
import { DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_MAX_RUNTIME_MS, DEFAULT_MAX_TOOL_CALLS } from './execution-policy.js';
export interface DeliveryEffectiveLimits { maxRuntimeMs: number; commandTimeoutMs: number; maxToolCalls: number; maxRepairAttempts: number; }
export interface DeliveryPlan {
  schemaVersion: 1; requestId: string; inputRevision: number; inputHash: string; baseline: string | null;
  objective: string; criteria: string[]; approvedPaths: string[];
  steps: Array<{ id: string; title: string; verification: string[] }>;
  dependencies: DeliveryDependencyReceipt[];
}
/** A retained execution plan is derived from accepted authority, never from mutable project settings. */
export function createDeliveryPlan(task: LocalTask, request: WorkerRequest, _dispatch: ModelRequest): DeliveryPlan {
  const checks = task.implementation?.checks.map(check => check.id) ?? [];
  return { schemaVersion: 1, requestId: request.id, inputRevision: request.inputRevision, inputHash: request.inputHash,
    baseline: task.baseCommit ?? null, objective: task.instruction, criteria: [...(request.input.criteria ?? [])],
    approvedPaths: [...(task.implementation?.approvedPaths ?? task.files.map(file => file.path))],
    steps: [
      { id: 'inspect', title: 'Inspect the accepted baseline, approved files and dependency receipts.', verification: [] },
      { id: 'implement', title: 'Implement the acceptance criteria within the approved file scope.', verification: [] },
      { id: 'verify', title: 'Run every required check against the exact candidate; repair within the accepted allowance.', verification: checks },
      { id: 'review', title: 'Prepare the immutable candidate and evidence for a separate human decision.', verification: checks },
    ], dependencies: structuredClone(task.dependencies ?? []) };
}
export function deliveryEffectiveLimits(dispatch: ModelRequest, run: Pick<DeliveryRun, 'maxRepairAttempts'>): DeliveryEffectiveLimits {
  return { maxRuntimeMs: dispatch.policy.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS,
    commandTimeoutMs: dispatch.policy.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    maxToolCalls: dispatch.policy.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS, maxRepairAttempts: run.maxRepairAttempts };
}
