import { completeConsumption, type ConsumptionRuntime } from './consumption.js';
import type { ConversationModel } from './conversation.js';
import { unknownUsage, type ProviderUsage } from './run-evidence.js';
import { executeModel, legacyModelReply, modelCapabilities, ProviderModelError, requireModelRequest, type ModelInvocationControl, type StructuredModel } from './model-contract.js';

/** Accounting owns its observer failures even when provider telemetry observers are isolated.
 * The adapter must call beforeCall immediately before each actual model dispatch.
 */
export async function withConsumption<T>(runtime: ConsumptionRuntime | undefined, provider: string, signal: AbortSignal,
  invoke: (signal: AbortSignal, observe: (usage: ProviderUsage) => void, control: ModelInvocationControl) => Promise<T>,
  onUsage?: (usage: ProviderUsage) => void): Promise<T> {
  signal.throwIfAborted();
  const attempt = runtime?.begin(provider), controller = new AbortController();
  const bounded = AbortSignal.any([signal, controller.signal]);
  let usage: ProviderUsage | undefined, accountingError: unknown, settled = false, complete = false;
  let dispatched = false, stopBeforeCall = false, boundaryStop: ProviderModelError | undefined;
  const checkAllowance = () => {
    if (!runtime || !attempt) return;
    const exhausted = runtime.observe(attempt.id, usage ?? unknownUsage());
    const status = runtime.status();
    if (!status.accountingAvailable) throw new ProviderModelError('unavailable');
    stopBeforeCall = exhausted || status.policy.enabled && (status.uncertainInvocations > 0 || usage !== undefined && !completeConsumption(usage));
  };
  const control: ModelInvocationControl = { beforeCall() {
    bounded.throwIfAborted();
    checkAllowance();
    if (stopBeforeCall) { boundaryStop = new ProviderModelError('consumption_limit'); throw boundaryStop; }
    dispatched = true;
  } };
  const observe = (value: ProviderUsage) => {
    if (settled) return;
    usage = structuredClone(value);
    if (runtime && attempt) {
      try {
        checkAllowance();
      } catch (error) { accountingError = error; controller.abort(); }
    }
    try { onUsage?.(value); } catch { /* Display telemetry cannot alter an invocation. */ }
  };
  try {
    const result = await invoke(bounded, observe, control);
    if (accountingError) throw accountingError;
    bounded.throwIfAborted();
    complete = true;
    return result;
  } catch (error) {
    // The preceding response was fully received; no new request crossed this boundary.
    if (boundaryStop && error === boundaryStop) complete = dispatched;
    throw accountingError ?? error;
  } finally {
    settled = true;
    if (attempt) {
      if (!dispatched && !complete && usage === undefined && !accountingError) runtime!.release(attempt.id);
      else runtime!.finish(attempt.id, usage, complete && !accountingError);
    }
  }
}

/** Every chat, patch, continuation and advisory review shares the worker's durable allowance. */
export function consumptionModel(model: ConversationModel | undefined, runtime: ConsumptionRuntime): StructuredModel | undefined {
  if (!model) return undefined;
  const structured = model as Partial<StructuredModel>;
  const wrapped: StructuredModel = {
    get configuration() { return structured.configuration ?? { id: 'legacy', model: '', instruction: '' }; },
    get capabilities() { return structured.capabilities ?? modelCapabilities; },
    get toolManifest() { return structured.toolManifest; },
    reply(messages, signal, onUsage) { return legacyModelReply(wrapped, messages, signal, onUsage); },
    execute(request, signal, onUsage, outerControl) {
      requireModelRequest(request, wrapped.configuration.id);
      return withConsumption(runtime, request.provider.id, signal, (bounded, observe, control) =>
        executeModel(model, request, bounded, observe, { beforeCall() { outerControl?.beforeCall(); control.beforeCall(); } }), onUsage);
    },
  };
  return wrapped;
}
