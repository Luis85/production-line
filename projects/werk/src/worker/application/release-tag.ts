import { DomainError } from '../../shared/errors.js';
function invalid(message: string): never { throw new DomainError('invalid_input', message); }

export function releaseTag(value: unknown, prefix = ''): string {
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes('..') || value.endsWith('.') || value.endsWith('.lock') || !value.startsWith(prefix))
    invalid('Release tags must be bounded simple Git tag names with the configured prefix.');
  return value;
}
