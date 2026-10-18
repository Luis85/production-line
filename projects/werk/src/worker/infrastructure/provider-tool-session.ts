import type { ModelSessionAccess } from '../application/model-session.js';
import { ProviderModelError, type ModelInvocationControl, type ModelRequest } from '../application/model-contract.js';
import type { ToolManifest, ToolRuntime } from '../application/tool-runtime.js';
export type ToolRuntimeFactory = (policy?: ModelRequest['policy']) => ToolRuntime;
export interface ProviderOptions { tools?: ToolRuntimeFactory; session?: ModelSessionAccess; }
/** Factories must remain lazy: metadata inspection starts no processes, timers or network sessions. */
export function currentToolManifest(factory?: ToolRuntimeFactory, policy?: ModelRequest['policy']): ToolManifest | undefined {
  const manifest = factory?.(policy).manifest;
  return manifest?.tools.length ? structuredClone(manifest) : undefined;
}
/** Older saved dispatches have no limits metadata; their revision and exact tool definitions still bind. */
function sameManifest(saved: ToolManifest | undefined, current: ToolManifest): boolean {
  if (!saved) return false;
  if (saved.limits !== undefined) return JSON.stringify(saved) === JSON.stringify(current);
  return JSON.stringify({ revision: saved.revision, tools: saved.tools }) === JSON.stringify({ revision: current.revision, tools: current.tools });
}
/** The saved dispatch carries descriptions, never authority. Only the current runtime can execute tools. */
export async function withProviderTools<T>(request: ModelRequest, signal: AbortSignal, factory: ToolRuntimeFactory | undefined, run: (runtime: ToolRuntime | undefined, signal: AbortSignal) => Promise<T>, control?: ModelInvocationControl): Promise<T> {
  const runtime = factory?.(request.policy);
  const bounded = request.policy.maxRuntimeMs ? AbortSignal.any([signal, AbortSignal.timeout(request.policy.maxRuntimeMs)]) : signal;
  try {
    if (request.policy.tools === 'granted' && (!runtime || !sameManifest(request.toolManifest, runtime.manifest))) throw new ProviderModelError('tool_access');
    const result = await run(request.policy.tools === 'granted' ? runtime : undefined, bounded);
    if (bounded.aborted) throw new ProviderModelError('cancelled');
    return result;
  } finally {
    await runtime?.close();
    const exhausted = runtime?.budget?.().exhausted;
    if (exhausted) try { control?.observeToolBudget?.(structuredClone(exhausted)); } catch { /* Evidence observers never replace the provider outcome. */ }
  }
}
export async function invokeGrantedTool(runtime: ToolRuntime, name: unknown, args: unknown, signal: AbortSignal) {
  if (signal.aborted) throw new ProviderModelError('cancelled');
  if (typeof name !== 'string' || !runtime.manifest.tools.some(tool => tool.name === name) || !args || typeof args !== 'object' || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > 65536) throw new ProviderModelError('protocol');
  try {
    const result = await runtime.call(name, args, signal);
    if (signal.aborted) throw new ProviderModelError('cancelled');
    if (Buffer.byteLength(JSON.stringify(result)) > 1048576) throw new ProviderModelError('protocol');
    return result;
  } catch (error) {
    if (error instanceof ProviderModelError) throw error;
    throw new ProviderModelError(signal.aborted ? 'cancelled' : 'tool_access');
  }
}
