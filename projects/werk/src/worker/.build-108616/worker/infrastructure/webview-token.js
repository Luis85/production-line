import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ValidationError } from '../../shared/errors.js';
import { atomicWrite, readBoundedFile } from './journal/files.js';

/** Explicit runtime configuration rotates local access; omitted configuration preserves persisted access. */
export async function loadWebviewToken(directory        , configured         )                  {
  if (configured !== undefined && (typeof configured !== 'string' || !/^[a-f0-9]{64}$/.test(configured)))
    throw new ValidationError('WERK_WORKER_TOKEN must contain exactly 64 lowercase hexadecimal characters.');
  const path = join(directory, 'webview-token');
  let saved                    ;
  try {
    saved = (await readBoundedFile(path, 128)).trim();
    if (!/^[a-f0-9]{64}$/.test(saved)) throw Error('Invalid worker webview token');
  } catch (error) {
    if ((error                         ).code !== 'ENOENT') throw error;
  }
  const token = configured ?? saved ?? randomBytes(32).toString('hex');
  if (token !== saved) await atomicWrite(path, token + '\n');
  return token;
}
