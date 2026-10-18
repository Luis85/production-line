const control = /[\x00-\x1f\x7f]/;

/** Why a string field is rejected, or undefined when it is acceptable. Mirrors the accepted-input rules exactly. */
export function stringProblem(value: unknown, max: number, empty: boolean): string | undefined {
  if (typeof value !== 'string') return 'is not text';
  if (max === 0 && value.length > 0) return 'must be empty here';
  if (value.length > max) return `is longer than ${max} characters`;
  if (!empty && !value.trim()) return 'is empty';
  if (control.test(value)) return 'contains control characters';
  return undefined;
}

/** Prefix a message with the configuration entry it concerns, when one is known. */
export const entryMessage = (entry: string | undefined, message: string): string => entry ? `${entry}: ${message}` : message;

/** Names an entry by its ID when that is a safe identifier, otherwise by its one-based position in the submitted list. */
export function entryLabel(kind: string, raw: unknown, index: number): string {
  const id = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as { id?: unknown }).id : undefined;
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? `${kind} "${id}"` : `${kind} #${index + 1}`;
}
