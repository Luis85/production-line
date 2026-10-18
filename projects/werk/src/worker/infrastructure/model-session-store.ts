import { join } from 'node:path';
import { SerializedOperations } from '../../shared/serialized-operations.js';
const operations = new Map<string, SerializedOperations>();
import { atomicWrite, assertDirectory, ensureDirectory, readBoundedFile } from './journal/files.js';
import { sessionDigest, validateModelSessionBinding, validateModelSessionUpdate, type ModelSessionBinding, type ModelSessionPort, type ModelSessionState, type ModelSessionUpdate } from '../application/model-session.js';

/** One private checkpoint per logical session; compare revisions before replacing it. */
export class FileModelSessionStore implements ModelSessionPort {
  private readonly directory: string;
  constructor(directory: string) { this.directory = directory; }
  private path(binding: ModelSessionBinding) { return join(this.directory, 'model-sessions', sessionDigest([binding.logicalSessionId, binding.generation]) + '.json'); }
  async load(binding: ModelSessionBinding): Promise<ModelSessionState> {
    validateModelSessionBinding(binding);
    let value: ModelSessionState;
    try { await assertDirectory(join(this.directory, 'model-sessions')); value = JSON.parse(await readBoundedFile(this.path(binding), 1024 * 1024)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, binding: structuredClone(binding), revision: 0, status: 'idle' }; throw error; }
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || sessionDigest(value.binding) !== sessionDigest(binding)) throw Error('Model session belongs to a different feature or provider.');
    validateModelSessionBinding(value.binding);
    const { schemaVersion: _schema, binding: _binding, revision: _revision, ...update } = value;
    validateModelSessionUpdate(update);
    return value;
  }
  save(binding: ModelSessionBinding, expectedRevision: number, next: ModelSessionUpdate): Promise<ModelSessionState> {
    validateModelSessionBinding(binding); validateModelSessionUpdate(next);
    const copied = structuredClone(next);
    const path = this.path(binding);
    if (!operations.has(path)) operations.set(path, new SerializedOperations());
    return operations.get(path)!.run(async () => {
      const current = await this.load(binding);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) throw Error('Model session checkpoint changed. Reload before continuing.');
      const value: ModelSessionState = { schemaVersion: 1, binding: structuredClone(binding), revision: current.revision + 1, ...copied };
      await ensureDirectory(join(this.directory, 'model-sessions'));
      if (current.revision > 0) {
        const archive = join(this.directory, 'model-sessions', 'history');
        await ensureDirectory(archive);
        await atomicWrite(join(archive, sessionDigest([binding.logicalSessionId, binding.generation]) + '-' + current.revision + '.json'), JSON.stringify(current) + '\n');
      }
      await atomicWrite(this.path(binding), JSON.stringify(value) + '\n');
      return value;
    });
  }
}
