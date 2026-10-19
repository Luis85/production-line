import { DomainError } from '../../shared/errors.js';

const modelEfforts = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type ModelEffort = typeof modelEfforts[number];
/** Provider-level options; the selected model may support a smaller set. */
export const providerEfforts: Readonly<Record<string, readonly ModelEffort[]>> = {
  'codex-cli': ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'claude-cli': ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
  'openai-api': ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'anthropic-api': ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
  'cursor-cli': ['default'],
};
export function parseModelEffort(value: unknown): ModelEffort {
  if (typeof value !== 'string' || !modelEfforts.includes(value as ModelEffort))
    throw new DomainError('invalid_input', 'Choose a supported model effort.');
  return value as ModelEffort;
}
export function validateModelEffort(value: unknown, provider: string): ModelEffort {
  const selected = value === undefined ? 'default' : value;
  if (typeof selected !== 'string' || !(providerEfforts[provider] ?? ['default']).includes(selected as ModelEffort))
    throw new DomainError('invalid_input', `Choose a supported effort for ${provider}. The selected model must support that effort.`);
  return selected as ModelEffort;
}
export function validateModelName(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200 || value.startsWith('-') || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value))
    throw new DomainError('invalid_input', 'Model must be an unpadded name of at most 200 characters without control characters or a leading dash.');
  return value;
}
