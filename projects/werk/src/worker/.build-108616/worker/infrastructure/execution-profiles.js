import { createHash } from 'node:crypto';
import { join } from 'node:path';
                                                                                     
import { atomicWrite, readBoundedFile } from './journal/files.js';

/** Private profile overrides survive restart without rewriting the installed worker configuration. */
export function executionProfilesStorage(directory        )                           {
  const path = join(directory, 'execution-profiles.json');
  return {
    async read() {
      try { return JSON.parse(await readBoundedFile(path, 16384)); }
      catch (error) { if ((error                         ).code !== 'ENOENT') throw error; }
    },
    async write(document) { await atomicWrite(path, JSON.stringify(document) + '\n'); },
    hash(value) { return createHash('sha256').update(value).digest('hex'); },
  };
}
