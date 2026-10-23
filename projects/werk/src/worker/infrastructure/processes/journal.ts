import { join } from 'node:path';
import { DomainError } from '../../../shared/errors.js';
import { serviceLimits, serviceOperationId, validateServiceScope } from '../../application/service-policy.js';
import type { ProcessJournal, StoredService } from '../../application/process-supervision.js';
import { atomicWrite, ensureDirectory, readBoundedFile } from '../journal/files.js';

/** Private bounded metadata/log snapshot; deliberately contains no process IDs to re-adopt. */
export function serviceJournal(directory: string): ProcessJournal {
  const path = join(directory, 'services.json');
  return {
    async load() {
      await ensureDirectory(directory);
      let text: string;
      try { text = await readBoundedFile(path, 8388608, true); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
      const value = JSON.parse(text) as { schemaVersion: number; services: StoredService[] };
      if (value.schemaVersion !== 1 || !Array.isArray(value.services) || value.services.length > serviceLimits.retainedServices) throw new DomainError('unavailable', 'The private service journal is invalid.');
      const seen = new Set<string>();
      for (const row of value.services) {
        validateServiceScope(row.scope);
        if (row.temporaryLogHours !== undefined && (!Number.isSafeInteger(row.temporaryLogHours) || row.temporaryLogHours < 0 || row.temporaryLogHours > 720) || !row.record || !serviceOperationId(row.record.id) || !serviceOperationId(row.operationId) || seen.has(row.record.id) || !Number.isSafeInteger(row.record.revision) || row.record.revision < 1 || !['starting', 'running', 'restarting', 'stopping', 'stopped', 'failed', 'interrupted'].includes(row.record.state)
          || row.record.featureRequestKey !== row.scope.featureRequestKey || row.record.sessionId !== row.scope.sessionId || !Number.isFinite(Date.parse(row.record.expiresAt)) || !Array.isArray(row.logs) || row.logs.length > serviceLimits.maxLogEntries || typeof row.presetFingerprint !== 'string'
          || !Number.isSafeInteger(row.nextLogSequence) || row.nextLogSequence < 1 || row.commands && (!Array.isArray(row.commands) || row.commands.length > 32)
          || row.logs.some(log => !Number.isSafeInteger(log.sequence) || typeof log.text !== 'string' || !['stdout', 'stderr'].includes(log.stream)) || row.logs.reduce((sum, log) => sum + Buffer.byteLength(log.text), 0) > serviceLimits.maxLogBytes) throw new DomainError('unavailable', 'The private service journal is invalid.');
        seen.add(row.record.id);
      }
      return value.services;
    },
    async save(services) { await ensureDirectory(directory); await atomicWrite(path, JSON.stringify({ schemaVersion: 1, services }) + '\n'); },
  };
}
