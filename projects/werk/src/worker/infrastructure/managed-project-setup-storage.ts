import { join } from 'node:path';
import { DomainError } from '../../shared/errors.js';
import { identifier } from '../../shared/contracts.js';
import { featureContentHash, featureWorkflowPath } from '../application/feature-workflow.js';
import { managedSetupDigest, type ManagedSetupPlan, type ManagedSetupState } from '../application/managed-project-setup.js';
import { atomicWrite, readBoundedFile } from './journal/files.js';
import { ordinaryDirectory, commitId } from './features/git-io.js';

const invalid = (): never => { throw new DomainError('conflict', 'The retained project setup journal is invalid. Restore its saved records before continuing.'); };
function plan(value: ManagedSetupPlan, projectId: string) {
  const { planDigest, ...subject } = value;
  if (value.schemaVersion !== 1 || value.projectId !== projectId || value.requiresPolicyApproval !== true || !commitId(value.baseCommit) || !commitId(value.checkoutCommit)
    || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 32 || value.files.some(file => {
      featureWorkflowPath(file.path); return !['create', 'preserve'].includes(file.status) || typeof file.content !== 'string' || Buffer.byteLength(file.content) > 65536 || featureContentHash(file.content) !== file.sha256;
    }) || new Set(value.files.map(file => file.path.toLowerCase())).size !== value.files.length || managedSetupDigest(subject) !== planDigest) invalid();
}
/** A bounded private outbox keeps the preview and exact commit before the first remote mutation. */
export function managedProjectSetupStorage(stateDirectory: string, projectId: string) {
  identifier(projectId, 'Project ID');
  const directory = join(stateDirectory, 'projects', projectId), path = join(directory, 'workflow-setup.json');
  return {
    async load(): Promise<ManagedSetupState> {
      let raw: string;
      try { raw = await readBoundedFile(path, 16 * 1024 * 1024); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, operations: [] }; throw error; }
      try {
        const state = JSON.parse(raw) as ManagedSetupState;
        if (state.schemaVersion !== 1 || !Array.isArray(state.operations) || state.operations.length > 16) invalid();
        if (state.plan) plan(state.plan, projectId);
        for (const operation of state.operations) {
          identifier(operation.operationId, 'Operation ID'); plan(operation.plan, projectId);
          if (!['prepared', 'unknown', 'published', 'not_published'].includes(operation.status) || operation.commit !== undefined && !commitId(operation.commit) || ['unknown', 'published'].includes(operation.status) && !operation.commit) invalid();
        }
        if (new Set(state.operations.map(operation => operation.operationId)).size !== state.operations.length) invalid();
        return state;
      } catch { return invalid(); }
    },
    async save(state: ManagedSetupState) {
      const content = JSON.stringify(state) + '\n';
      if (Buffer.byteLength(content) > 16 * 1024 * 1024) throw new DomainError('conflict', 'Project setup history reached its storage limit. Retain and inspect its journal before preparing another setup operation.');
      await ordinaryDirectory(directory); await atomicWrite(path, content);
    },
  };
}
