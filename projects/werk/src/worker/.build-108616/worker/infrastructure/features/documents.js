import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError } from '../../../shared/errors.js';
import { atomicWrite, readBoundedFile } from '../journal/files.js';
import { parseFeature, featureInput, requestName, digest } from './document.js';
                                                                                   

/** Access is serialized by FeatureRequests, alongside its watcher. */
export class FeatureDocuments                                {
          directory        ;         provider        ;         check                     ;
  constructor(directory        , provider        , check                     ) { this.directory = directory; this.provider = provider; this.check = check; }
          path(name        ) { if (!requestName(name)) throw new DomainError('invalid_input', 'Use a root-level .md filename without a leading underscore.'); return join(this.directory, name); }
  async read(name        ) {
    await this.check();
    try { const markdown = await readBoundedFile(this.path(name), 65536); return { name, markdown, revision: digest(markdown) }; }
    catch (error) { if ((error                         ).code === 'ENOENT') throw new DomainError('not_found', 'Feature file not found.'); throw error; }
  }
  validate(markdown        ) {
    try { const parsed = parseFeature(markdown); return { input: featureInput(parsed, this.provider), id: parsed.data.id, status: parsed.data.status, managed: parsed.data.werk !== undefined || parsed.data.source !== undefined, gates: (parsed.data.werk                                                                                                 )?.gates }; }
    catch (error) { throw new DomainError('invalid_input', error instanceof Error ? error.message : 'Invalid feature document.'); }
  }
  ready(markdown        ) { const parsed = parseFeature(markdown); parsed.document.set('status', 'ready'); return '---\n' + parsed.document.toString({ lineWidth: 0 }) + '---\n' + parsed.body; }
  async write(name        , markdown        , revision         ) {
    await this.check(); const path = this.path(name);
    if (revision !== undefined) {
      if ((await this.read(name)).revision !== revision) throw new DomainError('conflict', 'Feature changed. Read it again and reconcile before retrying.');
      await atomicWrite(path, markdown);
    } else {
      let handle;
      try { handle = await open(path, 'wx', 0o600); await handle.writeFile(markdown); await handle.sync(); }
      catch (error) { if ((error                         ).code === 'EEXIST') throw new DomainError('conflict', 'Feature filename already exists.'); throw error; }
      finally { await handle?.close(); }
    }
    return { name, markdown, revision: digest(markdown) };
  }
  async remove(name        , revision        ) {
    if ((await this.read(name)).revision !== revision) throw new DomainError('conflict', 'Feature changed. Read it again before deleting.');
    await unlink(this.path(name));
  }
}
