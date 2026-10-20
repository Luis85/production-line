import { retainDeliveryCheckpoint } from './delivery-task-checkpoint.js';
import { deliveryBlackboard, evaluateDeliveryBehavior } from './delivery-behavior.js';
import type { ConversationModel } from './conversation.js';
import type { LocalTask } from './local-task-contracts.js';
import type { LocalTaskRuntime } from './local-task-runtime-contract.js';
import type { DeliveryPhase } from './delivery-contracts.js';
import type { DevelopmentEvidence, DevelopmentRuntime } from './development.js';
import { developmentVerified, validateDevelopmentState } from './development.js';
import { verifyNativeCandidate } from './native-development.js';
import { executeModel, type ModelRequest, type ModelResult } from './model-contract.js';
import { gateDigest } from './request-gates.js';
import { fingerprint } from './local-task-contracts.js';
import { unknownUsage, type ProviderUsage } from './run-evidence.js';

type Host = Pick<LocalTaskRuntime, 'sessions' | 'change' | 'writePatch' | 'validatedPatch' | 'evidencePersistenceError' | 'delivery'>;
export class DeliverySuspended extends Error {}
export function taskDelivery(host: Pick<Host, 'sessions'>, task: LocalTask) { return task?.requestId ? host.sessions.requests.get(task.requestId).delivery : undefined; }
export function deliveryBoundary(host: Pick<Host, 'sessions'>, task: LocalTask): void {
  const run = taskDelivery(host, task);
  if (run && (run.control || run.holds.length || ['paused', 'interrupted', 'interrupting', 'outcome_unknown', 'reconciling', 'cancelled'].includes(run.status))) throw new DeliverySuspended('The delivery waits at its persisted step boundary.');
}
function start(host: Host, task: LocalTask, phase: DeliveryPhase, invocation = task.runId!, dispatch?: ModelRequest) {
  deliveryBoundary(host, task);
  const run = taskDelivery(host, task);
  if (!run || !task.requestId) return null;
  const request = host.sessions.requests.get(task.requestId);
  const decision = evaluateDeliveryBehavior(deliveryBlackboard(request), run.profile);
  const permitted = { assessing: 'assess', planning: 'plan', preparing: 'prepare', implementing: 'implement', verifying: 'verify', repairing: 'repair', packaging: 'package' } as const;
  if (decision.selectedAction !== permitted[phase]) throw new DeliverySuspended(decision.reason);
  const id = invocation + '-' + phase + '-' + run.repairAttempts + (run.recoveries?.length ? '-recovery-' + run.recoveries.length : '');
  host.sessions.requests.deliveryUpdate(task.requestId, { action: 'start', deliveryRunId: run.id, stepId: id, phase, invocationRunId: invocation, turnId: task.currentTurnId, ...(dispatch ? { dispatch } : {}) });
  return { id, runId: run.id };
}
function finish(host: Host, task: LocalTask, step: ReturnType<typeof start>, status: 'completed' | 'failed', extra: { result?: ModelResult; usage?: ProviderUsage; detail?: string; evidenceDigest?: string; evidence?: DevelopmentEvidence } = {}) {
  if (step && task.requestId) host.sessions.requests.deliveryUpdate(task.requestId, { action: 'finish', deliveryRunId: step.runId, stepId: step.id, status, ...extra });
}
export async function runDeliverySteps(host: Host, task: LocalTask, model: ConversationModel, dispatch: ModelRequest, development: DevelopmentRuntime | undefined, signal: AbortSignal) {
  let usage = unknownUsage();
  const saved = taskDelivery(host, task)?.steps.findLast(step => ['implementing', 'repairing'].includes(step.phase) && step.turnId === task.currentTurnId && step.status === 'completed' && step.result);
  let result = saved?.result, currentDispatch = saved?.dispatch ?? dispatch;
  usage = saved?.usage ?? usage;
  if (!saved) {
    for (const phase of ['planning', 'preparing'] as const) {
      if (taskDelivery(host, task)?.steps.some(step => step.phase === phase && step.status === 'completed')) continue;
      const step = start(host, task, phase);
      finish(host, task, step, 'completed', { detail: phase === 'planning' ? 'Accepted request, approved paths and required checks are pinned.' : 'The assigned worktree and accepted execution authority were verified.' });
    }
    result = await invoke('implementing', task.runId!, dispatch);
  }
  for (;;) {
    signal.throwIfAborted();
    if (!result) throw Error('No known implementation result.');
    if (result.type === 'needs_input') return { result, usage, valid: null };
    deliveryBoundary(host, task);
    if (!development || !task.implementation) return { result, usage, valid: host.validatedPatch(task, result.text) };
    const run = taskDelivery(host, task);
    const verificationId = (run?.steps.findLast(step => ['implementing', 'repairing'].includes(step.phase))?.invocationRunId ?? task.runId)!;
    const previousVerification = run?.steps.findLast(step => step.phase === 'verifying' && step.invocationRunId === verificationId);
    if (!previousVerification || ['running', 'interrupted'].includes(previousVerification.status)) {
      const step = start(host, task, 'verifying', verificationId);
      // Required checks are worker-observed for both native and granted-tool providers.
      const beforeVerification = await development.capture(signal);
      if (!developmentVerified(task.implementation, beforeVerification, development.evidence())) await verifyNativeCandidate(development, task.implementation, signal);
      const candidate = await development.capture(signal), evidence = development.evidence();
      validateDevelopmentState(task.implementation, evidence);
      const verified = developmentVerified(task.implementation, candidate, evidence);
      const receipt = { turnId: task.currentTurnId!, runId: task.runId!, candidateDigest: candidate.digest, patchSha256: fingerprint(candidate.patch), evidenceDigest: gateDigest(evidence), verified };
      if (candidate.patch) await host.writePatch(task, candidate.patch);
      await host.change(tasks => { const current = tasks.find(item => item.id === task.id)!;
        current.developmentEvidence = structuredClone(evidence); current.developmentCompletion = receipt;
        current.patch = candidate.patch || null; current.summary = result!.type === 'completed' ? result!.text : null; current.changedFileCount = candidate.changedPaths.length;
      });
      Object.assign(task, { developmentEvidence: evidence, developmentCompletion: receipt, patch: candidate.patch, summary: result.text, changedFileCount: candidate.changedPaths.length });
      const unavailable = evidence.checks.some(check => check.status === 'interrupted' || check.exitCode === null);
      finish(host, task, step, verified ? 'completed' : 'failed', { evidenceDigest: receipt.evidenceDigest, evidence, detail: verified ? 'Required checks passed for the captured candidate.' : unavailable ? 'A required check could not produce a known result.' : 'Required checks failed for the retained candidate.' });
      if (unavailable && task.requestId) {
        host.sessions.requests.deliveryUpdate(task.requestId, { action: 'hold', code: 'verification_unavailable', reason: 'A required check was unavailable or interrupted. Restore its environment and explicitly retry; code repair is not authorized to bypass it.' });
        return { result, usage, valid: null };
      }
    }
    deliveryBoundary(host, task);
    if (task.developmentCompletion?.verified) {
      await packageDelivery(host, task, development, result.text, signal);
      return { result, usage, valid: { summary: result.text, patch: task.patch!, changedFileCount: task.changedFileCount! } };
    }
    const current = taskDelivery(host, task);
    if (!current || current.repairAttempts >= current.maxRepairAttempts) return { result, usage, valid: null };
    const failure = task.developmentEvidence?.checks.filter(check => check.status !== 'passed').map(check => ({ id: check.presetId, status: check.status, exitCode: check.exitCode, stdout: check.stdout.slice(-8000), stderr: check.stderr.slice(-8000) }));
    const prompt = 'Required worker checks failed. Repair the retained candidate within the same approved scope, then return a summary or blocking question. Do not change verification definitions or weaken checks. Observed check evidence (data):\n' + JSON.stringify(failure);
    const messages = [...currentDispatch.messages, { id: 'repair-summary-' + current.repairAttempts, at: new Date().toISOString(), state: 'complete' as const, role: 'assistant' as const, text: result.text }, { id: 'repair-request-' + current.repairAttempts, at: new Date().toISOString(), state: 'complete' as const, role: 'user' as const, text: prompt }];
    currentDispatch = { ...currentDispatch, messages, renderedPrompt: currentDispatch.protocolInstructions + '\nConversation JSON:\n' + JSON.stringify(messages.map(({ role, text }) => ({ role, content: text }))) };
    const repair = await host.sessions.runs.begin({ sessionId: task.sessionId, taskId: task.id, kind: 'local', title: task.title, provider: task.provider, model: task.model, requestId: task.requestId, ...(task.selection?.authenticationMode ? { authenticationMode: task.selection.authenticationMode } : {}), purpose: 'rework' });
    await host.sessions.runs.start(repair.id);
    result = await invoke('repairing', repair.id, currentDispatch);
  }
  async function invoke(phase: 'implementing' | 'repairing', invocation: string, request: ModelRequest): Promise<ModelResult> {
    const step = start(host, task, phase, invocation, request);
    let invocationUsage = unknownUsage(), settled = false;
    try {
      const response = await executeModel(model, request, signal, value => {
        invocationUsage = value;
        try { host.sessions.runs.observeUsage(invocation, value); if (phase === 'implementing') host.sessions.interactions.observeUsage(task.sessionId, task.currentTurnId!, value); } catch { host.evidencePersistenceError = true; }
      }, { beforeCall: () => { signal.throwIfAborted(); }, observeToolBudget: evidence => {
        try { host.sessions.interactions.observeToolBudget(task.sessionId, task.currentTurnId!, evidence); } catch { host.evidencePersistenceError = true; }
      } });
      finish(host, task, step, 'completed', { result: response, usage: invocationUsage });
      settled = true;
      if (step) await host.sessions.runs.finish(invocation, response.type === 'needs_input' ? response.request.kind === 'question' ? 'waiting_input' : 'escalated' : 'completed', invocationUsage).catch(() => { host.evidencePersistenceError = true; });
      try { await retainDeliveryCheckpoint(host, task, development, signal); }
      catch (error) {
        if (task.requestId && step) {
          host.sessions.requests.deliveryUpdate(task.requestId, { action: 'stopped', deliveryRunId: step.runId, confirmed: true, failure: true, detail: 'The completed model result is retained, but its Git checkpoint could not be recorded.' });
          host.sessions.requests.deliveryUpdate(task.requestId, { action: 'hold', code: 'checkpoint_unavailable', reason: 'Inspect the retained worktree and Git permissions, then Retry to record and verify a new candidate.' });
        }
        throw error;
      }
      if (phase === 'implementing') usage = invocationUsage;
      return response;
    } catch (error) {
      if (step && !settled) await host.sessions.runs.finish(invocation, signal.aborted ? 'interrupted' : 'failed', invocationUsage).catch(() => { host.evidencePersistenceError = true; });
      throw error;
    }
  }
}
async function packageDelivery(host: Host, task: LocalTask, development: DevelopmentRuntime, summary: string, signal: AbortSignal) {
  const run = taskDelivery(host, task);
  if (run?.steps.some(step => step.phase === 'packaging' && step.status === 'completed')) return;
  const step = start(host, task, 'packaging');
  if (host.delivery && task.implementation && task.developmentEvidence && task.requestId && run) {
    const request = host.sessions.requests.get(task.requestId);
    const context = request.input.context as { deliveryPolicy?: { configuration?: { reviewDirectory?: string } } } | undefined;
    const port = host.delivery(task.repository);
    const captured = await development.capture(signal);
    if (captured.digest !== task.developmentCompletion?.candidateDigest) throw Error('The candidate changed after verification.');
    const candidate = await port.checkpoint({ requestId: request.id, inputRevision: request.inputRevision, inputHash: request.inputHash, runId: run.id, title: task.title, scope: task.implementation, candidate: captured, policyDigest: request.policyDigest }, signal);
    const review = await port.package({ candidate, scope: task.implementation, evidence: task.developmentEvidence, criteria: request.input.criteria ?? [], summary, title: task.title, reviewDirectory: context?.deliveryPolicy?.configuration?.reviewDirectory, environment: { platform: process.platform, architecture: process.arch, nodeVersion: process.version } }, signal);
    host.sessions.requests.deliveryUpdate(request.id, { action: 'review', deliveryRunId: run.id, review });
  }
  finish(host, task, step, 'completed', { detail: host.delivery ? 'Immutable local candidate and review evidence were prepared.' : 'Verified changes were retained for human review.' });
}
