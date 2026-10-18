import { DomainError } from '../../shared/errors.js';
import { candidateFileLimitError, candidateInspectionBounds, candidateInspectionFields, DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_MAX_RUNTIME_MS, DEFAULT_MAX_TOOL_CALLS, MAX_COMMAND_TIMEOUT_MS, MAX_MAX_RUNTIME_MS, MAX_TOOL_CALLS, type CandidateInspectionLimits } from './execution-policy.js';
import { ToolAccessError } from './tool-runtime.js';
import type { ToolPolicy } from './tool-policy.js';

/** Per-grant deadlines narrow execution authority; the invocation budget has one settings owner. */
export const toolTimeLimits = Object.freeze({
  callMinMs: 1000, callMaxMs: MAX_COMMAND_TIMEOUT_MS,
  mcpDefaultMs: 30000, mcpMaxMs: 15 * 60 * 1000,
  httpMcpMaxMs: 5 * 60 * 1000, webFetchMs: 10000,
});
export const formatToolDuration = (ms: number) => `${ms / 1000} s`;
/** Saved absence means inheritance; null is accepted only by the update boundary. */
export function callTimeout(value: unknown, label: string, maximum = toolTimeLimits.callMaxMs): number | undefined {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || Number(value) < toolTimeLimits.callMinMs || Number(value) > maximum)
    throw new DomainError('invalid_input', `${label} timeout must be whole milliseconds from ${toolTimeLimits.callMinMs} to ${maximum}.`);
  return Number(value);
}
function budget(value: number | undefined, fallback: number, maximum: number): number {
  const effective = value ?? fallback;
  // Sub-second values are supported by internal fixtures; editable settings require at least one second.
  if (!Number.isSafeInteger(effective) || effective < 1 || effective > maximum) throw new ToolAccessError('Invalid tool execution limits.');
  return effective;
}
/** Frozen candidate source bounds for one implementation attempt; absent values use the settings defaults. */
export function resolveCandidateInspectionLimits(input: Partial<CandidateInspectionLimits> = {}): Readonly<CandidateInspectionLimits> {
  const limits = Object.fromEntries(candidateInspectionFields.map(field => [field, budget(input[field], candidateInspectionBounds[field].default, candidateInspectionBounds[field].maximum)])) as unknown as CandidateInspectionLimits;
  if (limits.candidateFileMaxBytes > limits.candidateSourceMaxBytes) throw new ToolAccessError(candidateFileLimitError(limits.candidateFileMaxBytes, limits.candidateSourceMaxBytes));
  return Object.freeze(limits);
}
export function resolveCommandTimeoutMs(cap?: number, override?: number): number {
  const maximum = budget(cap, DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS);
  return Math.min(maximum, callTimeout(override, 'Command') ?? maximum);
}
export interface ToolExecutionBudget { maxCalls?: number; maxRuntimeMs?: number; commandTimeoutMs?: number; }
export interface ResolvedToolLimits {
  readonly maxCalls: number; readonly maxRuntimeMs: number; readonly commandTimeoutMs: number;
  readonly presetTimeoutMs: Readonly<Record<string, number>>;
  readonly cliTimeoutMs: Readonly<Record<string, number>>;
  readonly mcpTimeoutMs: Readonly<Record<string, number>>;
  readonly webTimeoutMs: number;
}
/** Immutable invocation snapshot, derived from the accepted budget and current grants. No processes are started. */
export function resolveToolLimits(policy: ToolPolicy, execution: ToolExecutionBudget = {}): ResolvedToolLimits {
  const maxCalls = budget(execution.maxCalls, DEFAULT_MAX_TOOL_CALLS, MAX_TOOL_CALLS);
  const maxRuntimeMs = budget(execution.maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS, MAX_MAX_RUNTIME_MS);
  const commandTimeoutMs = budget(execution.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS);
  const presetTimeoutMs = Object.fromEntries(policy.builtins.commands.filter(item => item.enabled).map(item => [item.id, resolveCommandTimeoutMs(commandTimeoutMs, item.timeoutMs)]));
  const cliTimeoutMs = Object.fromEntries((policy.builtins.cliTools ?? []).filter(item => item.enabled).map(item => [item.id, resolveCommandTimeoutMs(commandTimeoutMs, item.timeoutMs)]));
  const mcpTimeoutMs = Object.fromEntries(policy.mcp.filter(item => item.enabled).map(item => [item.id, callTimeout(item.timeoutMs, 'MCP connection', item.transport === 'http' ? toolTimeLimits.httpMcpMaxMs : toolTimeLimits.mcpMaxMs) ?? toolTimeLimits.mcpDefaultMs]));
  return Object.freeze({ maxCalls, maxRuntimeMs, commandTimeoutMs, presetTimeoutMs: Object.freeze(presetTimeoutMs), cliTimeoutMs: Object.freeze(cliTimeoutMs), mcpTimeoutMs: Object.freeze(mcpTimeoutMs), webTimeoutMs: toolTimeLimits.webFetchMs });
}
