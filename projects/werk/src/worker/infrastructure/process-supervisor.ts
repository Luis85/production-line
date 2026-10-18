import { join } from 'node:path';
import { ProcessSupervisor } from '../application/process-supervisor.js';
import type { ProcessSupervisorOptions } from '../application/process-supervision.js';
import { ensureDirectory } from './journal/files.js';
import { serviceJournal } from './processes/journal.js';
import { nodeServiceHost } from './processes/node-host.js';

export async function createProcessSupervisor(options: Omit<ProcessSupervisorOptions, 'journal' | 'host'> & { directory: string }): Promise<ProcessSupervisor> {
  const directory = join(options.directory, 'processes'); await ensureDirectory(directory);
  return ProcessSupervisor.open({ ...options, journal: serviceJournal(directory), host: nodeServiceHost(directory) });
}
