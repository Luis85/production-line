import { ValidationError } from '../../shared/errors.js';
/** Static approved-file rules shared by live execution and offline feature admission. Filesystem checks remain execution-owned. */
export function validateApprovedPaths(value: unknown, label = 'Approved paths'): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32 || value.some(path =>
    typeof path !== 'string' || path.length > 240 || !/^[a-zA-Z0-9_./ -]+$/.test(path) || path.startsWith('-') || path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || /(?:^|\/)(?:credentials?|secrets?|id_rsa|id_ed25519)(?:[./]|$)/i.test(path) || /\.(?:pem|key|p12|pfx)$/i.test(path))) throw new ValidationError(label + ' must contain 1–32 safe relative non-secret file paths');
  if (new Set(value).size !== value.length) throw new ValidationError(label + ' must be unique');
  return value as string[];
}
