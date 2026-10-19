import type { ProcessObservation } from '../application/process-observation.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ConversationModel } from '../application/conversation.js';
import type { DelegationPorts } from '../application/delegation.js';
import { observeConsumption, type ConsumptionRuntime } from '../application/consumption.js';
import { withConsumption } from '../application/consumption-model.js';
import { executeModel, legacyModelReply, modelCapabilities, prepareModelRequest, ProviderModelError, type StructuredModel } from '../application/model-contract.js';
import { validateModelSessionBinding, type ModelSessionPort } from '../application/model-session.js';
import { unknownUsage, validateRunLineage, type RunEvidence, type RunMetadata, type WorkerRun } from '../application/run-evidence.js';
import { DEFAULT_MAX_RUNTIME_MS } from '../application/execution-policy.js';
import type { ProviderConnection } from '../application/provider-contract.js';
import { FileModelSessionStore } from './model-session-store.js';
import { modelFor } from './providers.js';

type ChildModelFactory = (...args: Parameters<typeof modelFor>) => (ConversationModel & Partial<StructuredModel>) | undefined;
export interface DelegationChildOptions {
  connection: ProviderConnection;
  directory: string;
  featureRequestKey: string;
  parentSessionId: string;
  parent(): WorkerRun | undefined;
  runs: RunEvidence;
  consumption?: ConsumptionRuntime;
  observations?: ProcessObservation;
  model?: ChildModelFactory;
  sessionStore?: ModelSessionPort;
}

/** Borrow the parent runtime and open journal. No FR, board permit, grant or recovery cycle is created. */
export function createDelegationChildRunner(options: DelegationChildOptions): DelegationPorts['runChild'] {
  const connection = Object.freeze({ ...options.connection });
  const store = options.sessionStore ?? new FileModelSessionStore(options.directory);
  return async input => {
    input.signal.throwIfAborted();
    input.tools.assertAvailable?.(input.signal);
    if (input.tools.manifest.tools.some(tool => tool.name === 'werk_delegate')) throw new ProviderModelError('tool_access');
    const parent = options.parent();
    if (!parent || parent.sessionId !== options.parentSessionId || parent.provider !== connection.id || parent.model !== connection.model) throw new ProviderModelError('session_conflict');
    const sessionId = 'delegated-' + randomUUID();
    const binding = { schemaVersion: 1 as const, logicalSessionId: sessionId, featureRequestKey: options.featureRequestKey, providerId: connection.id, generation: 1 };
    validateModelSessionBinding(binding);
    const metadata: RunMetadata = {
      sessionId, taskId: parent.taskId, kind: parent.kind, title: parent.title, provider: parent.provider, model: parent.model,
      ...(parent.requestId ? { requestId: parent.requestId } : {}), ...(parent.purpose ? { purpose: parent.purpose } : {}),
      parentRunId: parent.id, parentSessionId: parent.sessionId, delegationId: input.id,
    };
    validateRunLineage(metadata, parent);
    const run = await options.runs.begin(metadata), evidenceAbort = new AbortController();
    const signal = AbortSignal.any([input.signal, evidenceAbort.signal]);
    let usage = unknownUsage(), evidenceError: unknown, result;
    try {
      await options.runs.start(run.id);
      const instance = (options.model ?? modelFor)(connection, join(options.directory, 'sessions', sessionId), undefined, { tools: () => input.tools, session: { binding, store } });
      if (!instance) throw new ProviderModelError('unavailable');
      const implementsCandidate = input.tools.manifest.tools.some(tool => tool.name === 'werk_candidate_apply');
      const model: StructuredModel = {
        sessionBinding: binding,
        configuration: { id: connection.id, model: connection.model, instruction: connection.instruction ?? '', ...(connection.effort === undefined ? {} : { effort: connection.effort }) },
        capabilities: instance.capabilities ?? modelCapabilities,
        toolManifest: input.tools.manifest.tools.length ? input.tools.manifest : undefined,
        executionPolicy: input.tools.limits ? { maxToolCalls: input.tools.limits.maxCalls, commandTimeoutMs: input.tools.limits.commandTimeoutMs, ...(implementsCandidate ? { ...input.tools.manifest.limits?.candidateInspection, ...input.tools.manifest.limits?.candidateReview } : {}) } : undefined,
        reply: (...args) => legacyModelReply(model, ...args),
        execute: (...args) => options.observations
          ? options.observations.run({ featureRequestKey: options.featureRequestKey, sessionId, taskId: parent.taskId ?? null, runId: run.id }, () => executeModel(instance, ...args))
          : executeModel(instance, ...args),
      };
      const operation = implementsCandidate ? 'patch' : 'chat';
      const request = prepareModelRequest(model, [{ id: randomUUID(), role: 'user', text: input.prompt, at: new Date().toISOString(), state: 'complete' }], operation, input.tools.limits?.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS);
      result = await withConsumption(options.consumption, connection.id, signal, (bounded, observe, control) => executeModel(model, request, bounded, observe, {
        beforeCall() {
          bounded.throwIfAborted();
          validateRunLineage(metadata, options.parent());
          input.tools.assertAvailable?.(bounded);
          control.beforeCall();
        },
      }), value => {
        usage = observeConsumption(usage, value);
        try { options.runs.observeUsage?.(run.id, usage); }
        catch (error) { evidenceError = error; evidenceAbort.abort(); }
      });
      if (evidenceError) throw evidenceError;
    } catch (error) {
      await options.runs.finish(run.id, input.signal.aborted ? 'cancelled' : 'failed', usage);
      throw evidenceError ?? error;
    }
    await options.runs.finish(run.id, result.type === 'completed' ? 'completed' : result.request.kind === 'escalation' ? 'escalated' : 'waiting_input', usage);
    return { sessionId, result, usage };
  };
}
