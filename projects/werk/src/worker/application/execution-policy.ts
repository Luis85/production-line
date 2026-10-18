import { ValidationError } from '../../shared/errors.js';
/** Candidate source bounds for verified implementation. Every tracked and non-ignored file is still read and fingerprinted. */
export interface CandidateInspectionLimits { candidateSourceMaxBytes: number; candidateSourceMaxFiles: number; candidateFileMaxBytes: number; }
export interface ExecutionPolicy extends CandidateInspectionLimits { maxRuntimeMs: number; maxToolCalls: number; commandTimeoutMs: number; }
export const EXECUTION_POLICY_FIELDS = ['maxRuntimeMs', 'maxToolCalls', 'commandTimeoutMs', 'candidateSourceMaxBytes', 'candidateSourceMaxFiles', 'candidateFileMaxBytes'] as const;
export const DEFAULT_MAX_RUNTIME_MS = 6 * 60 * 60 * 1000;
export const MIN_MAX_RUNTIME_MS = 1000;
export const MAX_MAX_RUNTIME_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_TOOL_CALLS = 128;
export const MAX_TOOL_CALLS = 512;
export const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
export const MIN_COMMAND_TIMEOUT_MS = 1000;
export const MAX_COMMAND_TIMEOUT_MS = 60 * 60 * 1000;
const MIB = 1024 * 1024;
/** Editable ranges; internal fixtures may use smaller positive values below the minimums. */
export const candidateInspectionBounds = Object.freeze({
  candidateSourceMaxBytes: Object.freeze({ default: 64 * MIB, minimum: MIB, maximum: 1024 * MIB }),
  candidateSourceMaxFiles: Object.freeze({ default: 20000, minimum: 1, maximum: 200000 }),
  candidateFileMaxBytes: Object.freeze({ default: 8 * MIB, minimum: 64 * 1024, maximum: 256 * MIB }),
});
export const candidateInspectionFields = Object.keys(candidateInspectionBounds) as Array<keyof CandidateInspectionLimits>;
function defaultCandidateInspectionLimits(): CandidateInspectionLimits {
  return { candidateSourceMaxBytes: candidateInspectionBounds.candidateSourceMaxBytes.default, candidateSourceMaxFiles: candidateInspectionBounds.candidateSourceMaxFiles.default, candidateFileMaxBytes: candidateInspectionBounds.candidateFileMaxBytes.default };
}
export function defaultExecutionPolicy(): ExecutionPolicy { return { maxRuntimeMs: DEFAULT_MAX_RUNTIME_MS, maxToolCalls: DEFAULT_MAX_TOOL_CALLS, commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS, ...defaultCandidateInspectionLimits() }; }
export function candidateFileLimitError(file: number, source: number): string {
  return `execution.candidateFileMaxBytes (${file}) cannot exceed execution.candidateSourceMaxBytes (${source}).`;
}
function candidateLimits(input: Partial<CandidateInspectionLimits>): CandidateInspectionLimits {
  const limits = defaultCandidateInspectionLimits();
  for (const field of candidateInspectionFields) {
    const value = input[field] === undefined ? limits[field] : input[field], { minimum, maximum } = candidateInspectionBounds[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ValidationError(`execution.${field} must be an integer from ${minimum} to ${maximum}.`);
    limits[field] = value;
  }
  if (limits.candidateFileMaxBytes > limits.candidateSourceMaxBytes) throw new ValidationError(candidateFileLimitError(limits.candidateFileMaxBytes, limits.candidateSourceMaxBytes));
  return limits;
}
export function validateExecutionPolicy(value: unknown): ExecutionPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !(EXECUTION_POLICY_FIELDS as readonly string[]).includes(key))) throw new ValidationError('Invalid execution policy.');
  const input = value as Partial<ExecutionPolicy>;
  const maxRuntimeMs = input.maxRuntimeMs;
  const maxToolCalls = input.maxToolCalls === undefined ? DEFAULT_MAX_TOOL_CALLS : input.maxToolCalls;
  const commandTimeoutMs = input.commandTimeoutMs === undefined ? DEFAULT_COMMAND_TIMEOUT_MS : input.commandTimeoutMs;
  if (typeof maxRuntimeMs !== 'number' || !Number.isSafeInteger(maxRuntimeMs) || maxRuntimeMs < MIN_MAX_RUNTIME_MS || maxRuntimeMs > MAX_MAX_RUNTIME_MS) throw new ValidationError('execution.maxRuntimeMs must be an integer from 1000 to 86400000.');
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > MAX_TOOL_CALLS) throw new ValidationError('execution.maxToolCalls must be an integer from 1 to 512.');
  if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs < MIN_COMMAND_TIMEOUT_MS || commandTimeoutMs > MAX_COMMAND_TIMEOUT_MS) throw new ValidationError('execution.commandTimeoutMs must be an integer from 1000 to 3600000.');
  return { maxRuntimeMs, maxToolCalls, commandTimeoutMs, ...candidateLimits(input) };
}
