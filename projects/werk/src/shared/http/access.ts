import { timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { ApiError } from './errors.js';
import { DomainError } from '../errors.js';

export interface Principal { id: string; role: 'admin' | 'operator' | 'viewer' }
export interface AccessDocument { schemaVersion: 1; principals: Array<{ id: string; role: 'operator' | 'viewer'; token: string }> }
const invalid = () => new DomainError('invalid_input', 'Invalid private access configuration; use schemaVersion 1 and up to 32 distinct operator/viewer principals.');
export function validateAccess(value: unknown): AccessDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const document = value as Record<string, unknown>;
  if (Object.keys(document).some(key => !['schemaVersion', 'principals'].includes(key)) || document.schemaVersion !== 1 || !Array.isArray(document.principals) || document.principals.length > 32) throw invalid();
  const ids = new Set<string>(), tokens = new Set<string>();
  const principals = document.principals.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['id', 'role', 'token'].includes(key))) throw invalid();
    const { id, role, token } = entry;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,62}$/.test(id) || id === 'legacy-admin' || !['operator', 'viewer'].includes(role) || typeof token !== 'string' || !/^[A-Za-z0-9._~-]{24,256}$/.test(token) || ids.has(id) || tokens.has(token)) throw invalid();
    ids.add(id); tokens.add(token); return { id, role, token };
  });
  return { schemaVersion: 1, principals };
}
/** Bounded, private, no-follow reads; absence is optional only for the default packaged path. */
export async function loadAccessFile(path?: string, optional = false): Promise<AccessDocument> {
  if (!path) return { schemaVersion: 1, principals: [] };
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) throw invalid();
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65536 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw invalid();
      const bytes = Buffer.alloc(65537); let offset = 0;
      for (;;) { const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset); offset += bytesRead; if (offset > 65536) throw invalid(); if (!bytesRead) break; }
      try { return validateAccess(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)))); }
      catch { throw invalid(); }
    } finally { await file.close(); }
  } catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, principals: [] }; throw error; }
}
function equal(actual: string, expected: string) { const a = Buffer.from(actual), b = Buffer.from(expected); return !!b.length && a.length === b.length && timingSafeEqual(a, b); }
export function accessAuthorization(adminToken: string, document: AccessDocument = { schemaVersion: 1, principals: [] }, reserved: string[] = []) {
  const access = validateAccess(document);
  if (access.principals.some(principal => [adminToken, ...reserved].includes(principal.token))) throw invalid();
  return (token: string): Principal => {
    if (equal(token, adminToken)) return { id: 'legacy-admin', role: 'admin' };
    let found: Principal | undefined;
    for (const principal of access.principals) if (equal(token, principal.token)) found = { id: principal.id, role: principal.role };
    if (!found) throw new ApiError(401, 'Valid access token required');
    return found;
  };
}
export function accessView(principal: Principal) { return { principal, permissions: { read: true, write: principal.role !== 'viewer' } }; }
export function requireWrite(principal: Principal) { if (principal.role === 'viewer') throw new ApiError(403, 'Viewer access is read-only; an operator token is required'); }

/** Preserve transport failure semantics when an adapter unexpectedly returns no object. */
export function withAccess<T extends object>(value: T, principal: Principal) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected an API response object');
  return { ...value, access: accessView(principal) };
}
