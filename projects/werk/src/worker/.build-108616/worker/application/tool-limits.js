import { DomainError } from '../../shared/errors.js';
import { DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_MAX_RUNTIME_MS, DEFAULT_MAX_TOOL_CALLS, MAX_COMMAND_TIMEOUT_MS, MAX_MAX_RUNTIME_MS, MAX_TOOL_CALLS } from './execution-policy.js';
import { ToolAccessError } from './tool-runtime.js';
                                                   

/** Per-grant deadlines narrow execution authority; the invocation budget has one settings owner. */
export const toolTimeLimits = Object.freeze({
  callMinMs: 1000, callMaxMs: MAX_COMMAND_TIMEOUT_MS,
  mcpDefaultMs: 30000, mcpMaxMs: 15 * 60 * 1000,
  httpMcpMaxMs: 5 * 60 * 1000, webFetchMs: 10000,
});
export const formatToolDuration = (ms        ) => `${ms / 1000} s`;
/** Saved absence means inheritance; null is accepted only by the update boundary. */
export function callTimeout(value         , label        , maximum = toolTimeLimits.callMaxMs)                     {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || Number(value) < toolTimeLimits.callMinMs || Number(value) > maximum)
    throw new DomainError('invalid_input', `${label} timeout must be whole milliseconds from ${toolTimeLimits.callMinMs} to ${maximum}.`);
  return Number(value);
}
function budget(value                    , fallback        , maximum        )         {
  const effective = value ?? fallback;
  // Sub-second values are supported by internal fixtures; editable settings require at least one second.
  if (!Number.isSafeInteger(effective) || effective < 1 || effective > maximum) throw new ToolAccessError('Invalid tool execution limits.');
  return effective;
}
export function resolveCommandTimeoutMs(cap         , override         )         {
  const maximum = budget(cap, DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS);
  return Math.min(maximum, callTimeout(override, 'Command') ?? maximum);
}
                                                                                                             
                                     
                                                                                              
                                                             
                                                          
                                                          
                                
 
/** Immutable invocation snapshot, derived from the accepted budget and current grants. No processes are started. */
export function resolveToolLimits(policy            , execution                      = {})                     {
  const maxCalls = budget(execution.maxCalls, DEFAULT_MAX_TOOL_CALLS, MAX_TOOL_CALLS);
  const maxRuntimeMs = budget(execution.maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS, MAX_MAX_RUNTIME_MS);
  const commandTimeoutMs = budget(execution.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS);
  const presetTimeoutMs = Object.fromEntries(policy.builtins.commands.filter(item => item.enabled).map(item => [item.id, resolveCommandTimeoutMs(commandTimeoutMs, item.timeoutMs)]));
  const cliTimeoutMs = Object.fromEntries((policy.builtins.cliTools ?? []).filter(item => item.enabled).map(item => [item.id, resolveCommandTimeoutMs(commandTimeoutMs, item.timeoutMs)]));
  const mcpTimeoutMs = Object.fromEntries(policy.mcp.filter(item => item.enabled).map(item => [item.id, callTimeout(item.timeoutMs, 'MCP connection', item.transport === 'http' ? toolTimeLimits.httpMcpMaxMs : toolTimeLimits.mcpMaxMs) ?? toolTimeLimits.mcpDefaultMs]));
  return Object.freeze({ maxCalls, maxRuntimeMs, commandTimeoutMs, presetTimeoutMs: Object.freeze(presetTimeoutMs), cliTimeoutMs: Object.freeze(cliTimeoutMs), mcpTimeoutMs: Object.freeze(mcpTimeoutMs), webTimeoutMs: toolTimeLimits.webFetchMs });
}
