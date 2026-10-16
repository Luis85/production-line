import type { ToolDefinition } from './tool-policy.js';

/** Private identity retained at task admission; never part of the model dispatch. */
export interface ToolWorktreeIdentity { dev: string; ino: string; birthtimeMs: number; }
/**
 * Execution limits captured with an invocation, as dispatch evidence. `callTimeoutMs` names each
 * tool with its own deadline; `werk_command_run` reports its longest preset and `presetTimeoutMs`
 * each preset. File tools have no separate deadline and are bounded by the shared window.
 */
export interface ToolManifestLimits { maxCalls: number; windowMs: number; callTimeoutMs: Record<string, number>; presetTimeoutMs?: Record<string, number>; }
/** Public invocation snapshot. Credentials and host paths never belong in a dispatch. */
export interface ToolManifest { revision: number; tools: ToolDefinition[]; limits?: ToolManifestLimits; }
export interface ToolResult { content: { type: 'text'; text: string }[]; isError?: boolean; }
export interface ToolRuntime {
  readonly manifest: ToolManifest;
  call(name: string, args: unknown, signal: AbortSignal): Promise<ToolResult>;
  /** Idempotently cancel and await in-flight calls before releasing execution capacity. */
  close(): Promise<void>;
}
export class ToolAccessError extends Error {
  constructor(message = 'Tool access is unavailable. Check the current worker tool permissions.') { super(message); this.name = 'ToolAccessError'; }
}
