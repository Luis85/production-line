import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ExecutionProfilesStorage } from '../application/execution-profiles.js';
import { atomicWrite, readBoundedFile } from './journal/files.js';

/** Private profile overrides survive restart without rewriting the installed worker configuration. */
export function executionProfilesStorage(directory: string): ExecutionProfilesStorage {
  const path = join(directory, 'execution-profiles.json');
  return {
    async read() {
      try { return JSON.parse(await readBoundedFile(path, 16384)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    },
    async write(document) { await atomicWrite(path, JSON.stringify(document) + '\n'); },
    hash(value) { return createHash('sha256').update(value).digest('hex'); },
  };
}
