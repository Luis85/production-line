import { join } from 'node:path';
import { DomainError } from '../../shared/errors.js';
import { identifier, object, text } from '../../shared/contracts.js';
import { atomicWrite, readBoundedFile } from './journal/files.js';
import { managedRepository, type ManagedProject, type ManagedProjectState } from '../application/managed-projects.js';
import { featureWorkflowPath } from '../application/feature-workflow.js';
import { remoteDeliveryBranch } from '../application/remote-delivery-policy.js';

function invalid(): never { throw new DomainError('unavailable', 'Managed project state is invalid. Restore its retained registration journal before continuing.'); }
/** Bounded private persistence; never infer new authority from partial or malformed state. */
export function managedProjectStorage(stateDirectory: string) {
  const path = join(stateDirectory, 'managed-projects.json');
  return {
    async load(): Promise<ManagedProjectState> {
      let content: string;
      try { content = await readBoundedFile(path, 1024 * 1024); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, projects: [] }; throw error; }
      try {
        const value = object(JSON.parse(content), 'Managed project journal', ['schemaVersion', 'projects']);
        if (value.schemaVersion !== 1 || !Array.isArray(value.projects) || value.projects.length > 64) invalid();
        const projects = value.projects.map(item => {
          const p = object(item, 'Managed project', ['id', 'name', 'mode', 'repository', 'branch', 'featuresDirectory', 'pollMs', 'intake', 'path', 'operationId', 'status', 'attached', 'createdAt', 'updatedAt', 'detail', 'head', 'operations']);
          const id = identifier(p.id, 'Project ID');
          if (p.pollMs !== undefined && (!Number.isSafeInteger(p.pollMs) || Number(p.pollMs) < 1000 || Number(p.pollMs) > 300000)) invalid();
          if (p.intake === undefined) p.intake = 'local';
          if (p.intake !== 'shared' && p.intake !== 'local') invalid();
          if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id) || !['clone', 'adopt'].includes(String(p.mode)) ||
              !['preparing', 'ready', 'needs_attention'].includes(String(p.status)) || typeof p.attached !== 'boolean' ||
              !Array.isArray(p.operations) || p.operations.length > 32 || !p.operations.length ||
              p.head !== undefined && (typeof p.head !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(p.head))) invalid();
          for (const key of ['name', 'path', 'createdAt', 'updatedAt', 'detail'] as const) text(p[key], key, key === 'path' ? 4096 : 2000);
          identifier(p.operationId, 'Project operation ID');
          managedRepository(p.repository); remoteDeliveryBranch(p.branch); featureWorkflowPath(p.featuresDirectory);
          for (const operation of p.operations) {
            const op = object(operation, 'Project operation', ['operationId', 'digest', 'action']);
            identifier(op.operationId, 'Operation ID');
            if (!['register', 'adopt', 'reconcile', 'retry'].includes(String(op.action)) || typeof op.digest !== 'string' || !/^[a-f0-9]{64}$/.test(op.digest)) invalid();
          }
          return p as unknown as ManagedProject;
        });
        if (new Set(projects.map(p => p.id)).size !== projects.length || new Set(projects.flatMap(p => p.operations.map(op => op.operationId))).size !== projects.reduce((total, p) => total + p.operations.length, 0)) invalid();
        return { schemaVersion: 1, projects };
      } catch { return invalid(); }
    },
    async save(state: ManagedProjectState) { await atomicWrite(path, JSON.stringify(state) + '\n'); },
  };
}
