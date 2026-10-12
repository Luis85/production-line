import { lstat } from 'node:fs/promises';
import { loadAccessFile } from '../../src/orchestrator/dist/shared/http/access.js';
/** Ignore only a genuinely absent optional file; malformed/symlink state fails startup. */
export async function configureAccessFile(environment, path) {
  delete environment.WERK_ACCESS_FILE;
  try { await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await loadAccessFile(path);
  environment.WERK_ACCESS_FILE = path;
}
