import { ProviderModelError, type ModelRequest } from '../application/model-contract.js';
import type { ToolManifest, ToolRuntime } from '../application/tool-runtime.js';
export interface ProviderOptions { tools?: () => ToolRuntime; }
export function currentToolManifest(factory?: () => ToolRuntime): ToolManifest | undefined {
  const manifest = factory?.().manifest;
  return manifest?.tools.length ? structuredClone(manifest) : undefined;
}
/** The saved dispatch carries descriptions, never authority. Only the current runtime can execute tools. */
export async function withProviderTools<T>(request: ModelRequest, signal: AbortSignal, factory: (() => ToolRuntime) | undefined, run: (runtime: ToolRuntime | undefined, signal: AbortSignal) => Promise<T>): Promise<T> {
  const runtime = factory?.();
  const bounded = request.policy.maxRuntimeMs ? AbortSignal.any([signal, AbortSignal.timeout(request.policy.maxRuntimeMs)]) : signal;
  try {
    if (request.policy.tools === 'granted' && (!runtime || JSON.stringify(request.toolManifest) !== JSON.stringify(runtime.manifest))) throw new ProviderModelError('tool_access');
    const result = await run(request.policy.tools === 'granted' ? runtime : undefined, bounded);
    if (bounded.aborted) throw new ProviderModelError('cancelled');
    return result;
  } finally { await runtime?.close(); }
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
