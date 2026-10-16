import type { ToolDefinition } from './tool-policy.js';

/** Private identity retained at task admission; never part of the model dispatch. */
export interface ToolWorktreeIdentity { dev: string; ino: string; birthtimeMs: number; }
/** Public invocation snapshot. Credentials and host paths never belong in a dispatch. */
export interface ToolManifest { revision: number; tools: ToolDefinition[]; }
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
