import type { ToolDefinition } from './tool-policy.js';
import type { CandidateInspectionLimits } from './execution-policy.js';

/** Private identity retained at task admission; never part of the model dispatch. */
export interface ToolWorktreeIdentity { dev: string; ino: string; birthtimeMs: number; }
/**
 * Execution limits captured with an invocation, as dispatch evidence. `callTimeoutMs` names each
 * tool with its own deadline; `werk_command_run` reports its longest preset and `presetTimeoutMs`
 * each preset. `windowMs` records the existing overall invocation budget; it is not a separate
 * tool-policy window. File tools have no separate deadline. `candidateInspection` records the
 * candidate source bounds frozen for an implementation attempt; it is present only with candidate tools.
 */
export interface ToolManifestLimits { maxCalls: number; windowMs: number; callTimeoutMs: Record<string, number>; presetTimeoutMs?: Record<string, number>; candidateInspection?: CandidateInspectionLimits; }
/** Public invocation snapshot. Credentials and host paths never belong in a dispatch. */
export interface ToolManifest { revision: number; tools: ToolDefinition[]; limits?: ToolManifestLimits; }
export interface ToolResult { content: { type: 'text'; text: string }[]; isError?: boolean; }
/**
 * Evidence that an invocation's shared tool budget ran out: the call limit was reached or the
 * tool window ended. Counts and durations only; never tool names, arguments, results or paths.
 * `callsUsed` counts calls admitted to execution; `refusedCalls` counts calls that returned the
 * budget message instead of a tool result, including a call stopped when the window ended.
 */
export interface ToolBudgetEvidence { reason: 'calls' | 'window'; maxCalls: number; windowMs: number; callsUsed: number; refusedCalls: number; }
export interface ToolBudget { maxCalls: number; windowMs: number; callsUsed: number; refusedCalls: number; exhausted: ToolBudgetEvidence | null; }
export interface ToolRuntime {
  readonly manifest: ToolManifest;
  /** Invocation-frozen execution ceilings; omitted by legacy adapter fixtures. */
  readonly limits?: Readonly<{ maxCalls: number; maxRuntimeMs: number; commandTimeoutMs: number }>;
  call(name: string, args: unknown, signal: AbortSignal): Promise<ToolResult>;
  /** Current budget accounting for this invocation. Optional so injected test runtimes stay valid. */
  budget?(): ToolBudget;
  /** Idempotently cancel and await in-flight calls before releasing execution capacity. */
  close(): Promise<void>;
}
export class ToolAccessError extends Error {
  constructor(message = 'Tool access is unavailable. Check the current worker tool permissions.') { super(message); this.name = 'ToolAccessError'; }
}
