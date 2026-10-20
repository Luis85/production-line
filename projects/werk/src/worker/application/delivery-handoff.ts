import { randomUUID } from 'node:crypto';
import type { DeliveryTaskHost } from './delivery-step-boundary.js';
import { taskDelivery, deliveryBoundary } from './delivery-step-boundary.js';
import { deliveryExecution, deliveryProfileModel, prepareHandoffDispatch } from './delivery-provider-runtime.js';
import { retainDeliveryCheckpoint } from './delivery-task-checkpoint.js';
import { ProviderModelError, type ModelRequest } from './model-contract.js';
import type { DevelopmentRuntime } from './development.js';
import type { LocalTask } from './local-task-contracts.js';
import type { DeliveryProviderHandoff } from './delivery-provider-contracts.js';
function deliveryFallbackReason(error: unknown): DeliveryProviderHandoff['reason'] | undefined {
  if (!(error instanceof ProviderModelError)) return;
  return error.code === 'quota' ? 'quota_exhausted' : error.code === 'rate_limit' ? 'rate_limited' : error.code === 'unavailable' ? 'unavailable' : undefined;
}
/** Called only after the source adapter has settled and its failure is durable. */
export async function prepareDeliveryHandoff(host: DeliveryTaskHost, task: LocalTask, development: DevelopmentRuntime | undefined, previous: ModelRequest, sourceStepId: string, sourceInvocationRunId: string, error: unknown, signal: AbortSignal) {
  const reason = deliveryFallbackReason(error), accepted = deliveryExecution(host, task), run = taskDelivery(host, task);
  if (!reason || !accepted || !run || !task.requestId || !development || !accepted.policy.fallbackOn.includes(reason) || (run.handoffs?.length ?? 0) >= accepted.policy.maxHandoffs) return;
  signal.throwIfAborted(); deliveryBoundary(host, task);
  const sourceProfileId = run.handoffs?.at(-1)?.targetProfileId ?? accepted.resolution.profile.id;
  const targetProfileId = accepted.policy.fallbackProfiles.find(id => id !== sourceProfileId && !run.handoffs?.some(item => item.targetProfileId === id));
  if (!targetProfileId) return;
  const captured = await development.capture(signal), checkpoint = await retainDeliveryCheckpoint(host, task, development, signal);
  if (captured.patch.trim() && (!checkpoint || checkpoint.candidateDigest !== captured.digest)) throw Error('A provider handoff requires its retained partial-work checkpoint.');
  const logicalSessionId = randomUUID();
  const { model, snapshot } = deliveryProfileModel(host, task, accepted, targetProfileId, development, logicalSessionId);
  const summary = 'Continue the accepted Feature Request from retained local work. The prior provider stopped with a known ' + reason + ' outcome. It did not complete the request. Preserve existing changes, inspect the current candidate, finish the accepted criteria and run required verification. The previous provider native session is not reused. Context data: ' + JSON.stringify({ candidateDigest: captured.digest, checkpointCommit: checkpoint?.candidateCommit ?? null, changedPaths: captured.changedPaths, checks: development.evidence().checks.map(check => ({ id: check.presetId, status: check.status, exitCode: check.exitCode })), plan: run.plan?.steps, latestAssessment: run.assessments?.at(-1) ? { summary: run.assessments.at(-1)!.summary, findings: run.assessments.at(-1)!.findings } : null });
  if (summary.length > 16000) throw Error('The bounded provider handoff context is too large.');
  const dispatch = prepareHandoffDispatch(model, previous, summary);
  const next = await host.sessions.runs.begin({ sessionId: task.sessionId, taskId: task.id, kind: 'local', title: task.title, provider: snapshot.selection.provider, model: snapshot.selection.model, authenticationMode: snapshot.selection.authenticationMode, requestId: task.requestId, purpose: 'rework' });
  const receipt: DeliveryProviderHandoff = { id: randomUUID(), sourceStepId, sourceProfileId, targetProfileId, sourceInvocationRunId, targetInvocationRunId: next.id, logicalSessionId, requestId: task.requestId, inputRevision: run.inputRevision, inputHash: run.inputHash, deliveryRunId: run.id, policyDigest: run.policyDigest, reason, at: new Date().toISOString(), candidateDigest: captured.digest, checkpointCommit: checkpoint?.candidateCommit ?? null, baseline: task.baseCommit ?? null, summary, freshSession: true };
  host.sessions.requests.deliveryUpdate(task.requestId, { action: 'handoff', deliveryRunId: run.id, handoff: receipt });
  return { model, dispatch, invocation: next.id, profileId: targetProfileId, handoffId: receipt.id };
}
