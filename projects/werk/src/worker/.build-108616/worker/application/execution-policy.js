import { ValidationError } from '../../shared/errors.js';
                                                                                                          
export const DEFAULT_MAX_RUNTIME_MS = 6 * 60 * 60 * 1000;
export const MIN_MAX_RUNTIME_MS = 1000;
export const MAX_MAX_RUNTIME_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_TOOL_CALLS = 128;
export const MAX_TOOL_CALLS = 512;
export const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
export const MIN_COMMAND_TIMEOUT_MS = 1000;
export const MAX_COMMAND_TIMEOUT_MS = 60 * 60 * 1000;
export function defaultExecutionPolicy()                  { return { maxRuntimeMs: DEFAULT_MAX_RUNTIME_MS, maxToolCalls: DEFAULT_MAX_TOOL_CALLS, commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS }; }
export function validateExecutionPolicy(value         )                  {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['maxRuntimeMs', 'maxToolCalls', 'commandTimeoutMs'].includes(key))) throw new ValidationError('Invalid execution policy.');
  const input = value                            ;
  const maxRuntimeMs = input.maxRuntimeMs;
  const maxToolCalls = input.maxToolCalls === undefined ? DEFAULT_MAX_TOOL_CALLS : input.maxToolCalls;
  const commandTimeoutMs = input.commandTimeoutMs === undefined ? DEFAULT_COMMAND_TIMEOUT_MS : input.commandTimeoutMs;
  if (typeof maxRuntimeMs !== 'number' || !Number.isSafeInteger(maxRuntimeMs) || maxRuntimeMs < MIN_MAX_RUNTIME_MS || maxRuntimeMs > MAX_MAX_RUNTIME_MS) throw new ValidationError('execution.maxRuntimeMs must be an integer from 1000 to 86400000.');
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > MAX_TOOL_CALLS) throw new ValidationError('execution.maxToolCalls must be an integer from 1 to 512.');
  if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs < MIN_COMMAND_TIMEOUT_MS || commandTimeoutMs > MAX_COMMAND_TIMEOUT_MS) throw new ValidationError('execution.commandTimeoutMs must be an integer from 1000 to 3600000.');
  return { maxRuntimeMs, maxToolCalls, commandTimeoutMs };
}
