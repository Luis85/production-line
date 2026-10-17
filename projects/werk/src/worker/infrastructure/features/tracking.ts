import { createHash, randomUUID } from 'node:crypto';
import { link, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { identifier } from '../../../shared/validation.js';
import { DomainError } from '../../../shared/errors.js';
import { renderFeatureTracking, type FeatureTrackingDocuments, type FeatureTrackingProjection, type FeatureTrackingRecord } from '../../application/feature-tracking.js';
import { atomicWrite, readBoundedFile, syncDirectory } from '../journal/files.js';
import { realDirectory } from './folder.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const maximumNoteBytes = 4 * 1024 * 1024;
interface Metadata { schemaVersion: number; source: string; sessionId: string; taskId: string; status: string; updatedAt: string; werkTracking: { owner: string; digest: string } }
function metadata(markdown: string): Metadata {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(markdown)?.[1];
  if (!frontmatter || Buffer.byteLength(frontmatter) > 32768) throw Error('Tracking note metadata is unavailable.');
  const document = parseDocument(frontmatter, { strict: true, uniqueKeys: true, customTags: [] });
  if (document.errors.length || document.warnings.length) throw Error('Tracking note metadata is invalid.');
  const value = document.toJS({ maxAliasCount: 0 }) as Metadata;
  if (!value || value.schemaVersion !== 1 || value.source !== 'worker-tracking' || !value.werkTracking || typeof value.werkTracking.owner !== 'string' || !/^[a-f0-9]{64}$/.test(value.werkTracking.digest) || typeof value.taskId !== 'string' || typeof value.status !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw Error('This file is not a worker-owned tracking note.');
  return value;
}
/** A separate namespace keeps generated progress notes out of both local and shared Git intake. */
export class MarkdownFeatureTracking implements FeatureTrackingDocuments {
  readonly directory: string;
  private stateDirectory: string;
  private owner?: string;
  constructor(directory: string, stateDirectory: string) { this.directory = resolve(directory); this.stateDirectory = resolve(stateDirectory); }
  async init() {
    await realDirectory(this.stateDirectory, true);
    if (!this.owner) {
      const ownerPath = join(this.stateDirectory, 'feature-tracking-owner.json');
      const readOwner = async () => {
        const value = JSON.parse(await readBoundedFile(ownerPath, 1024));
        if (value.schemaVersion !== 1 || typeof value.owner !== 'string' || !/^[a-f0-9-]{36}$/.test(value.owner)) throw Error('Invalid tracking owner.');
        return value.owner as string;
      };
      try { this.owner = await readOwner(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const owner = randomUUID();
        let file;
        try { file = await open(ownerPath, 'wx', 0o600); await file.writeFile(JSON.stringify({ schemaVersion: 1, owner }) + '\n'); await file.sync(); this.owner = owner; await syncDirectory(this.stateDirectory); }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure; this.owner = await readOwner(); }
        finally { await file?.close(); }
      }
    }
    await realDirectory(this.directory, true);
  }
  private filename(sessionId: string) { identifier(sessionId, 'sessionId'); return 'fr-' + hash(sessionId).slice(0, 24) + '.md'; }
  private owned(markdown: string, sessionId: string) {
    const value = metadata(markdown);
    if (value.sessionId !== sessionId || value.werkTracking.owner !== this.owner) throw Error('A foreign note occupies this feature-request filename.');
    return value;
  }
  private record(value: Metadata, markdown: string): FeatureTrackingRecord {
    const filename = this.filename(value.sessionId);
    return { sessionId: value.sessionId, taskId: value.taskId, filename, path: join(this.directory, filename), revision: hash(markdown), updatedAt: value.updatedAt, status: value.status };
  }
  async write(projection: FeatureTrackingProjection): Promise<FeatureTrackingRecord> {
    await this.init();
    const path = join(this.directory, this.filename(projection.sessionId));
    const digest = hash(JSON.stringify(projection));
    let previous: string | undefined;
    try { previous = await readBoundedFile(path, maximumNoteBytes, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous !== undefined) {
      const existing = this.owned(previous, projection.sessionId);
      if (existing.werkTracking.digest === digest) return this.record(existing, previous);
    }
    const markdown = renderFeatureTracking(projection, { owner: this.owner!, digest, updatedAt: new Date().toISOString() });
    if (Buffer.byteLength(markdown) > maximumNoteBytes) throw Error('Feature-request note exceeds its storage limit.');
    if (previous === undefined) {
      const temporary = path + '.' + randomUUID() + '.tmp';
      let file;
      try {
        file = await open(temporary, 'wx', 0o600); await file.writeFile(markdown); await file.sync(); await file.close();
        // An exclusive hard-link publishes a complete file without replacing a concurrent foreign note.
        await link(temporary, path); await syncDirectory(this.directory);
      } finally { await file?.close().catch(() => {}); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    } else {
      // Recheck the observed regular file immediately before replacing it; never overwrite an unrelated editor's replacement.
      if (await readBoundedFile(path, maximumNoteBytes, true) !== previous) throw Error('Feature-request note changed during synchronization.');
      await atomicWrite(path, markdown);
    }
    return this.record(this.owned(markdown, projection.sessionId), markdown);
  }
  async read(sessionId: string) {
    await this.init();
    let markdown: string;
    try { markdown = await readBoundedFile(join(this.directory, this.filename(sessionId)), maximumNoteBytes, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DomainError('not_found', 'The saved feature-request note is missing. Refresh to recreate it.'); throw error; }
    const value = this.owned(markdown, sessionId);
    return { ...this.record(value, markdown), markdown };
  }
}
