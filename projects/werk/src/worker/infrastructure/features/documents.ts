import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError } from '../../../shared/errors.js';
import { readBoundedFile } from '../journal/files.js';
import { replaceFeatureFile } from './recoverable-write.js';
import { submissionIntent, requestSchema } from './markdown-contract.js';
import { parseFeature, featureInput, requestName, digest } from './document.js';
import type { FeatureDocumentPort } from '../../application/feature-management.js';

/** Access is serialized by FeatureRequests, alongside its watcher. */
export class FeatureDocuments implements FeatureDocumentPort {
  private directory: string; private provider: string | (() => string); private check: () => Promise<void>;
  constructor(directory: string, provider: string | (() => string), check: () => Promise<void>) { this.directory = directory; this.provider = provider; this.check = check; }
  private path(name: string) { if (!requestName(name)) throw new DomainError('invalid_input', 'Use a root-level .md filename without a leading underscore.'); return join(this.directory, name); }
  async read(name: string) {
    await this.check();
    try { const markdown = await readBoundedFile(this.path(name), 65536); return { name, markdown, revision: digest(markdown) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DomainError('not_found', 'Feature file not found.'); throw error; }
  }
  validate(markdown: string) {
    try { const parsed = parseFeature(markdown); return { input: featureInput(parsed, typeof this.provider === 'function' ? this.provider() : this.provider), id: parsed.data.id, status: parsed.data.schema === requestSchema ? submissionIntent(parsed.data) : parsed.data.status, ...(typeof parsed.data.schema === 'string' ? { schema: parsed.data.schema } : {}), managed: parsed.data.werk !== undefined || parsed.data.source !== undefined, gates: (parsed.data.werk as { gates?: import('../../application/feature-requests.js').FeatureGateProjection } | undefined)?.gates }; }
    catch (error) { throw new DomainError('invalid_input', error instanceof Error ? error.message : 'Invalid feature document.'); }
  }
  ready(markdown: string) { const parsed = parseFeature(markdown); parsed.document.set(parsed.data.schema === requestSchema ? 'intent' : 'status', parsed.data.schema === requestSchema ? 'submit' : 'ready'); return '---\n' + parsed.document.toString({ lineWidth: 0 }) + '---\n' + parsed.body; }
  async write(name: string, markdown: string, revision?: string) {
    await this.check(); const path = this.path(name);
    if (revision !== undefined) {
      const before = await this.read(name);
      if (before.revision !== revision) throw new DomainError('conflict', 'Feature changed. Read it again and reconcile before retrying.');
      if (!await replaceFeatureFile(path, before.markdown, markdown, join(this.directory, '_conflicts'))) throw new DomainError('conflict', 'Feature changed during save. Reconcile the current note and retained _conflicts copy before retrying.');
    } else {
      let handle;
      try { handle = await open(path, 'wx', 0o600); await handle.writeFile(markdown); await handle.sync(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DomainError('conflict', 'Feature filename already exists.'); throw error; }
      finally { await handle?.close(); }
    }
    return { name, markdown, revision: digest(markdown) };
  }
  async remove(name: string, revision: string) {
    if ((await this.read(name)).revision !== revision) throw new DomainError('conflict', 'Feature changed. Read it again before deleting.');
    await unlink(this.path(name));
  }
}
