import { ValidationError } from '../../shared/errors.js';
/** Candidate source bounds for verified implementation. Every tracked and non-ignored file is still read and fingerprinted. */
export interface CandidateInspectionLimits { candidateSourceMaxBytes: number; candidateSourceMaxFiles: number; candidateFileMaxBytes: number; }
/** Approved-content bounds for implementation candidates: what a reviewer receives, never what is inspected. */
export interface CandidateReviewLimits { candidateApprovedFileMaxBytes: number; candidateApprovedTotalMaxBytes: number; candidateReviewPatchMaxBytes: number; }
/** Every limit frozen into an implementation dispatch. */
export type CandidateLimits = CandidateInspectionLimits & CandidateReviewLimits;
export interface ExecutionPolicy extends CandidateLimits { maxRuntimeMs: number; maxToolCalls: number; commandTimeoutMs: number; }
export const EXECUTION_POLICY_FIELDS = ['maxRuntimeMs', 'maxToolCalls', 'commandTimeoutMs', 'candidateSourceMaxBytes', 'candidateSourceMaxFiles', 'candidateFileMaxBytes', 'candidateApprovedFileMaxBytes', 'candidateApprovedTotalMaxBytes', 'candidateReviewPatchMaxBytes'] as const;
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
/**
 * Defaults keep the fixed 0.13 review bounds. The review patch is stored in the 16 MiB taskboard document, so its
 * 4 MiB maximum always leaves room; it also bounds approved content in practice.
 */
export const candidateReviewBounds = Object.freeze({
  candidateApprovedFileMaxBytes: Object.freeze({ default: 24000, minimum: 1000, maximum: 8 * MIB }),
  candidateApprovedTotalMaxBytes: Object.freeze({ default: 48000, minimum: 1000, maximum: 64 * MIB }),
  candidateReviewPatchMaxBytes: Object.freeze({ default: 120000, minimum: 10000, maximum: 4 * MIB }),
});
export const candidateReviewFields = Object.keys(candidateReviewBounds) as Array<keyof CandidateReviewLimits>;
export const candidateLimitBounds = Object.freeze({ ...candidateInspectionBounds, ...candidateReviewBounds });
export const candidateLimitFields = [...candidateInspectionFields, ...candidateReviewFields];
function defaultCandidateLimits(): CandidateLimits {
  return Object.fromEntries(candidateLimitFields.map(field => [field, candidateLimitBounds[field].default])) as unknown as CandidateLimits;
}
export function defaultExecutionPolicy(): ExecutionPolicy { return { maxRuntimeMs: DEFAULT_MAX_RUNTIME_MS, maxToolCalls: DEFAULT_MAX_TOOL_CALLS, commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS, ...defaultCandidateLimits() }; }
export function candidateFileLimitError(file: number, source: number): string {
  return `execution.candidateFileMaxBytes (${file}) cannot exceed execution.candidateSourceMaxBytes (${source}).`;
}
export function candidateApprovedLimitError(file: number, total: number): string {
  return `execution.candidateApprovedTotalMaxBytes (${total}) must be at least execution.candidateApprovedFileMaxBytes (${file}).`;
}
function candidateLimits(input: Partial<CandidateLimits>): CandidateLimits {
  const limits = defaultCandidateLimits();
  for (const field of candidateLimitFields) {
    const value = input[field] === undefined ? limits[field] : input[field], { minimum, maximum } = candidateLimitBounds[field];
    const size = field.endsWith('Bytes') && maximum % MIB === 0 ? ` (${maximum / MIB} MiB)` : '';
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ValidationError(`execution.${field} must be an integer from ${minimum} to ${maximum}${size}.`);
    limits[field] = value;
  }
  if (limits.candidateFileMaxBytes > limits.candidateSourceMaxBytes) throw new ValidationError(candidateFileLimitError(limits.candidateFileMaxBytes, limits.candidateSourceMaxBytes));
  if (limits.candidateApprovedTotalMaxBytes < limits.candidateApprovedFileMaxBytes) throw new ValidationError(candidateApprovedLimitError(limits.candidateApprovedFileMaxBytes, limits.candidateApprovedTotalMaxBytes));
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
