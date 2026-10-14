import { ValidationError } from '../../shared/errors.js';
export interface ExecutionPolicy { maxRuntimeMs: number; }
export const DEFAULT_MAX_RUNTIME_MS = 6 * 60 * 60 * 1000;
export const MIN_MAX_RUNTIME_MS = 1000;
export const MAX_MAX_RUNTIME_MS = 24 * 60 * 60 * 1000;
export function defaultExecutionPolicy(): ExecutionPolicy { return { maxRuntimeMs: DEFAULT_MAX_RUNTIME_MS }; }
export function validateExecutionPolicy(value: unknown): ExecutionPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'maxRuntimeMs')) throw new ValidationError('Invalid execution policy.');
  const maxRuntimeMs = (value as ExecutionPolicy).maxRuntimeMs;
  if (!Number.isSafeInteger(maxRuntimeMs) || maxRuntimeMs < MIN_MAX_RUNTIME_MS || maxRuntimeMs > MAX_MAX_RUNTIME_MS) throw new ValidationError('execution.maxRuntimeMs must be an integer from 1000 to 86400000.');
  return { maxRuntimeMs };
}
