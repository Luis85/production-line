import { validateFeatureRequestReference } from '../../application/feature-request-reference.js';
import { MarkdownFeatureTaskNotes } from './task-documents.js';
import { validateFeatureTaskProjection } from '../../application/feature-task-notes.js';
import { exportFeatureGates, validateFeatureGates } from './gates.js';
import type { WorkerRequest } from '../../application/request-gates.js';
import { exportFeatureEvidence, writeImmutableFeatureArtifact, validateFeatureExecution } from './evidence.js';
import { FeatureDocuments } from './documents.js';
import { open, readdir, lstat, mkdir, unlink } from 'node:fs/promises';
import { resolve, join, parse, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { atomicWrite, readBoundedFile } from '../journal/files.js';
import { parseFeature, featureInput, renderFeature, featureId, requestName, digest, featureTemplate } from './document.js';
import type { FeatureFolderPort, FeatureFile, FeatureRecord, FeatureIndex, FeatureExecutionEvidence } from '../../application/feature-requests.js';

export async function realDirectory(path: string, create = false) {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (create) await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Feature directory ancestors must be real directories, not symlinks.');
  }
}
function overlaps(a: string, b: string) { const r = relative(a, b); return !r || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r)); }
export class MarkdownFeatureFolder implements FeatureFolderPort {
  readonly directory: string;
  readonly documents: FeatureDocuments;
  readonly taskNotes: MarkdownFeatureTaskNotes;
  private state: string; private lock?: Awaited<ReturnType<typeof open>>;
  private defaultProvider: string;
  constructor(directory: string, state: string, defaultProvider: string, project: string) {
    this.defaultProvider = defaultProvider;
    this.directory = resolve(directory); this.state = resolve(state);
    this.taskNotes = new MarkdownFeatureTaskNotes(this.directory, path => realDirectory(path, true));
    this.documents = new FeatureDocuments(this.directory, defaultProvider, () => realDirectory(this.directory));
    if (this.directory === resolve(project) || overlaps(this.directory, this.state) || overlaps(this.state, this.directory) || ['.git', 'node_modules'].some(name => this.directory.split(sep).includes(name))) throw Error('Use a dedicated feature folder separate from project root, private worker state, .git and node_modules.');
  }
  async load(): Promise<FeatureIndex> {
    try {
      const index = JSON.parse(await readBoundedFile(join(this.state, 'feature-index.json'), 16777216));
      if (index.version !== 1 || typeof index.owner !== 'string' || !featureId.test(index.owner) || !Array.isArray(index.records) || index.records.length > 1000 || new Set(index.records.map((r: FeatureRecord) => r.id)).size !== index.records.length) throw Error('Invalid feature index.');
      for (const record of index.records) if (!record || !featureId.test(record.id) || !requestName(record.name) || !['folder', 'orchestrator'].includes(record.source) || typeof record.submitted !== 'boolean' || typeof record.inputHash !== 'string' || typeof record.taskId !== 'string' || typeof record.sessionId !== 'string' || !record.submitted && !record.input) throw Error('Invalid feature index record.');
      for (const record of index.records) {
        if (record.feature) { const reference = validateFeatureRequestReference(record.feature); if (record.source === 'folder' && (reference.source !== 'folder' || reference.id !== record.id)) throw Error('Invalid feature parent identity.'); }
        validateFeatureTaskProjection(record, index.owner);
        validateFeatureExecution(record);
        validateFeatureGates(record);
        if (record.interaction && (!Number.isSafeInteger(record.interaction.revision) || record.interaction.revision < 0 || typeof record.interaction.phase !== 'string' || (record.interaction.pendingId && !featureId.test(record.interaction.pendingId)) || (record.interaction.link && record.interaction.link !== `_questions/${record.id}/${record.interaction.pendingId}.md`))) throw Error('Invalid feature interaction projection.');
      }
      return index;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const index: FeatureIndex = { version: 1, owner: randomUUID(), records: [] }; await this.save(index); return index;
    }
  }
  async save(index: FeatureIndex) {
    const text = JSON.stringify(index);
    if (Buffer.byteLength(text) > 16777216) throw Error('Feature index storage limit reached.');
    await atomicWrite(join(this.state, 'feature-index.json'), text);
  }
  async open(owner: string) {
    await realDirectory(this.directory, true);
    const path = join(this.directory, '_worker.lock');
    this.lock = await open(path, 'wx', 0o600).catch(() => { throw Error('Feature folder is locked. Stop its other worker; after a crash verify the process is stopped before removing _worker.lock.'); });
    try {
      await this.lock.writeFile(JSON.stringify({ pid: process.pid, owner }) + '\n'); await this.lock.sync();
      const marker = join(this.directory, '_worker-owner.json');
      try { if (JSON.parse(await readBoundedFile(marker, 1024)).owner !== owner) throw Error('This feature folder belongs to another worker state. Move its existing state with the folder or choose a separate feature folder.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await atomicWrite(marker, JSON.stringify({ owner }) + '\n'); }
      await realDirectory(join(this.directory, '_templates'), true); await realDirectory(join(this.directory, '_results'), true);
      const template = join(this.directory, '_templates/feature-request.md');
      const existing = await lstat(template).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!existing) { const file = await open(template, 'wx', 0o600); try { await file.writeFile(featureTemplate); } finally { await file.close(); } }
      else if (!existing.isFile() || existing.isSymbolicLink()) throw Error('Feature template must be a regular file.');
    } catch (error) { await this.close(); throw error; }
  }
  async scan(): Promise<FeatureFile[]> {
    await realDirectory(this.directory);
    const names = (await readdir(this.directory)).filter(requestName).sort();
    if (names.length > 1000) throw Error('Feature folder holds more than 1,000 Markdown requests.');
    const files: FeatureFile[] = [];
    for (const name of names) {
      try {
        const raw = await readBoundedFile(join(this.directory, name), 65536), parsed = parseFeature(raw), d = parsed.data, shared = Object.hasOwn(d, 'templateId');
        files.push({ name, revision: digest(raw), ...(typeof d.id === 'string' ? { id: d.id } : {}), status: d.status === undefined ? undefined : String(d.status), source: String(d.source ?? 'folder'), shared, ...(shared || d.source === 'orchestrator' ? {} : { input: featureInput(parsed, this.defaultProvider) }) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        // Parse/validation messages contain no source contents or YAML parser diagnostics.
        files.push({ name, revision: '', error: error instanceof Error ? error.message.slice(0, 500) : 'Request could not be read.' });
      }
    }
    return files;
  }
  async update(file: FeatureFile, record: FeatureRecord, inputChanged: boolean) {
    if (!requestName(file.name)) throw Error('Invalid feature filename.');
    await realDirectory(this.directory);
    const path = join(this.directory, file.name);
    const current = await readBoundedFile(path, 65536).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (current === null || digest(current) !== file.revision) return false;
    const parsed = parseFeature(current);
    if (Object.hasOwn(parsed.data, 'templateId')) return false;
    const next = renderFeature(parsed, record.id, record.status, { archived: record.archived ?? false, source: record.source, taskId: record.taskId, sessionId: record.sessionId, submittedAt: record.createdAt, updatedAt: record.updatedAt, inputHash: record.inputHash, ...(record.attempt !== undefined ? { attempt: record.attempt } : {}), ...(record.error ? { error: record.error } : {}), ...(record.result ? { result: record.result } : {}), ...(record.patch ? { patch: record.patch } : {}), ...(record.execution ? { execution: record.execution } : {}), ...(record.executionDirectory ? { executionDirectory: record.executionDirectory } : {}), ...(record.interaction ? { interaction: record.interaction } : {}), ...(record.taskNote ? { task: { link: record.taskNote.link, status: record.taskNote.submission?.outcome ?? 'open' } } : {}), ...(record.attention ? { attention: record.attention } : {}), ...(record.gates ? { gates: record.gates, requestPhase: record.gates.phase, executionStatus: record.executionStatus } : {}), ...(inputChanged ? { inputChanged: true, note: 'Accepted input is frozen. Copy to a new filename and remove id/werk to request different work.' } : {}) });
    if (next === current) return true;
    // Optimistic editor protection; a changed observation is retried on the next scan.
    if (await readBoundedFile(path, 65536) !== current) return false;
    await atomicWrite(path, next); return true;
  }
  async createRemote(record: FeatureRecord, title: string, markdown: string) {
    if (!requestName(record.name)) throw Error('Invalid remote feature filename.');
    await realDirectory(this.directory);
    const path = join(this.directory, record.name);
    try {
      const existing = parseFeature(await readBoundedFile(path, 65536));
      if (existing.data.id !== record.id || existing.data.source !== 'orchestrator') throw Error('An unrelated file occupies the orchestrator feature filename.');
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const raw = '---\n' + stringify({ schemaVersion: 1, id: record.id, title, source: 'orchestrator', status: record.status, werk: { taskId: record.taskId, sessionId: record.sessionId, attempt: record.attempt } }) + '---\n' + markdown;
    const file = await open(path, 'wx', 0o600); try { await file.writeFile(raw); await file.sync(); } finally { await file.close(); }
  }
  async gates(record: FeatureRecord, request: WorkerRequest) {
    return exportFeatureGates(this.directory, record, request, path => realDirectory(path, true));
  }
  async evidence(record: FeatureRecord, evidence: FeatureExecutionEvidence) {
    return exportFeatureEvidence(this.directory, record, evidence, path => realDirectory(path, true));
  }
  async result(record: FeatureRecord, text: string, patch?: string) {
    if (!featureId.test(record.id)) throw Error('Invalid feature ID.');
    validateFeatureExecution(record);
    const directory = join(this.directory, '_results'); await realDirectory(directory);
    const review = record.source === 'folder' && record.input?.mode === 'patch' && !!patch && ['review', 'completed'].includes(record.executionStatus ?? record.status);
    const details = (prefix: string, patchName: string, immutable: boolean) => review ? '\n## Review the proposed change\n\nThis is a proposed patch for human review. The worker has not merged or applied it. Inspect the [patch](' + patchName + ') and verify the acceptance criteria before applying any change.\n\n' +
      (immutable ? 'Review [current request checks](' + prefix + '_gates/' + record.id + '/request.md) where available; they may change after this run was recorded.\n' : record.gates ? 'Readiness: ' + record.gates.ready + '. Completion checks: ' + record.gates.done + '. [Saved checks](' + prefix + record.gates.link + ').\n' : 'Completion checks have not been recorded.\n') : '';
    const render = (prefix: string, patchName: string, immutable = false, parentIdentity = true) => '---\n' + stringify({ schemaVersion: 1, ...(review ? { type: 'PullRequest' } : {}), featureId: record.id, ...(parentIdentity && record.feature ? { featureRequestKey: record.feature.key } : {}), source: record.source, status: record.executionStatus ?? record.status, taskId: record.taskId, sessionId: record.sessionId, updatedAt: record.execution?.completedAt ?? record.updatedAt, ...(record.execution ? { execution: record.execution } : {}) }) + '---\n# ' + (review ? 'Pull request review' : 'Worker result') + '\n\n' + text + '\n' + details(prefix, patchName, immutable);
    const raw = render('../', record.id + '.patch');
    if (record.execution?.after) {
      const executionDirectory = join(directory, record.id); await realDirectory(executionDirectory, true);
      // The mutable latest result is a convenience; each run keeps its own original result.
      const path = join(executionDirectory, record.execution.runId + '.md');
      const previous = await readBoundedFile(path, 524288).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
      // Keep byte-identical evidence written before PullRequest notes were introduced.
      const legacy = '---\n' + stringify({ schemaVersion: 1, featureId: record.id, source: record.source, status: record.executionStatus ?? record.status, taskId: record.taskId, sessionId: record.sessionId, updatedAt: record.execution.completedAt ?? record.updatedAt, execution: record.execution }) + '---\n# Worker result\n\n' + text + '\n';
      const priorReview = render('../../', record.execution.runId + '.patch', true, false);
      if (previous !== legacy && previous !== priorReview) await writeImmutableFeatureArtifact(path, render('../../', record.execution.runId + '.patch', true));
      if (patch) await writeImmutableFeatureArtifact(join(executionDirectory, record.execution.runId + '.patch'), patch);
    }
    await this.writeChanged(join(directory, record.id + '.md'), raw);
    if (patch) await this.writeChanged(join(directory, record.id + '.patch'), patch);
    else await unlink(join(directory, record.id + '.patch')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  private async writeChanged(path: string, text: string) {
    const previous = await readBoundedFile(path, 524288).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
    if (previous !== text) await atomicWrite(path, text);
  }
  async report(value: { records: FeatureRecord[]; errors: { file: string; message: string }[] }) {
    const escape = (s: string) => s.replace(/[\r\n|]/g, ' ');
    const missing = new Set((await readdir(this.directory)).filter(requestName));
    const rows = value.records.map(record => `| ${escape(record.name)} | ${record.status} | ${record.source} | ${record.execution ? `[Run ${record.execution.attempt}](${encodeURI(record.execution.before)})` + (record.execution.after ? ` · [after](${encodeURI(record.execution.after)})` : ' · after not recorded') : 'Not recorded'} | ${missing.has(record.name) ? escape(record.error ?? '') : 'File missing; accepted work is not cancelled.'} |`);
    const text = '# Worker feature queue\n\nGenerated by the worker. Underscore-prefixed files and folders are not ingested.\n\n| Request | State | Source | Execution evidence | Note |\n| --- | --- | --- | --- | --- |\n' + rows.join('\n') + '\n\n## Intake errors\n\n' + (value.errors.length ? value.errors.map(error => '- ' + escape(error.file) + ': ' + escape(error.message)).join('\n') : 'None.') + '\n';
    await realDirectory(this.directory); await this.writeChanged(join(this.directory, '_worker-status.md'), text);
  }
  async close() { if (!this.lock) return; const handle = this.lock; this.lock = undefined; await handle.close(); await unlink(join(this.directory, '_worker.lock')); }
}
