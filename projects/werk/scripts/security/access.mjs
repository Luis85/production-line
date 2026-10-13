import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { rename, unlink, lstat } from 'node:fs/promises';
import { createPrivate, readPrivate, inputError } from '../runtime/config.mjs';
import { validateAccess } from '../../src/orchestrator/dist/shared/http/access.js';
async function stateDirectory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw inputError('Service state must be an existing private real directory.');
  // Require existing service credentials. Never initialize or change application authority here.
  const credentials = await readPrivate(join(path, 'credentials.json'));
  const admin = credentials.WERK_ADMIN_TOKEN ?? credentials.WERK_FACTORY_ADMIN_TOKEN;
  if (typeof admin !== 'string' || !/^[a-f0-9]{64}$/.test(admin)) throw inputError('Expected an existing Factory or orchestrator state directory.');
}
async function optionalAccess(path) {
  try { return validateAccess(await readPrivate(path)); }
  catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, principals: [] }; throw error; }
}
async function atomicPrivate(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try { await createPrivate(temporary, value); await rename(temporary, path); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
/** Named credentials only. The legacy admin is preserved so every edit has a recovery authority. */
export async function accessCommand(action, { stateDir, id, role } = {}) {
  if (!stateDir) throw inputError('--state-dir must name the Factory or orchestrator service state directory.');
  stateDir = resolve(stateDir); await stateDirectory(stateDir);
  const path = join(stateDir, 'access.json'), previous = join(stateDir, 'access.previous.json');
  if (action === 'list') {
    const access = await optionalAccess(path);
    return { ok: true, principals: access.principals.map(({ id, role }) => ({ id, role })), restartRequired: false };
  }
  if (!['grant', 'rotate', 'revoke', 'rollback'].includes(action)) throw inputError('Unknown access action.');
  if (action !== 'rollback' && (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,62}$/.test(id) || id === 'legacy-admin')) throw inputError('--id requires 1–63 lowercase identifier characters; legacy-admin is reserved.');
  if (action === 'grant' && !['operator', 'viewer'].includes(role)) throw inputError('--role must be operator or viewer.');
  const lock = join(stateDir, 'access.lock');
  try { await createPrivate(lock, { schemaVersion: 1, pid: process.pid }); }
  catch (error) { if (error.code === 'EEXIST') throw inputError('Another credential edit holds access.lock. Verify its owner exited before recovering a stale lock.'); throw error; }
  try {
    const current = await optionalAccess(path); let next;
    if (action === 'rollback') next = validateAccess(await readPrivate(previous));
    else {
      next = structuredClone(current); const existing = next.principals.find(entry => entry.id === id);
      if (action === 'grant') {
        if (existing) throw inputError('Principal already exists. Rotate its credential or revoke it before changing roles.');
        next.principals.push({ id, role, token: randomBytes(32).toString('hex') });
      } else {
        if (!existing) throw inputError('Unknown principal. Existing credentials were preserved.');
        if (action === 'rotate') existing.token = randomBytes(32).toString('hex');
        else next.principals = next.principals.filter(entry => entry.id !== id);
      }
      next = validateAccess(next);
    }
    // Validate any existing rollback before replacement; refuse symlinks or corrupt state.
    await optionalAccess(previous);
    await atomicPrivate(previous, current);
    await atomicPrivate(path, next);
    return { ok: true, action, ...(id ? { id } : {}), credentialFile: path, previousFile: previous, restartRequired: true,
      next: 'Restart the owning runtime, then verify the new credential and rejection of the old one. Read tokens privately from access.json; tokens are never printed.' };
  } finally { await unlink(lock); }
}
