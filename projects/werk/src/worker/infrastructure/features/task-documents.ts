import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import type { FeatureTaskProjection, FeatureTaskDocument, FeatureTaskNotesPort } from '../../application/feature-task-notes.js';
import { featureTaskLink } from '../../application/feature-task-notes.js';
import type { FeatureRecord, FeatureQueuePort } from '../../application/feature-requests.js';
import type { InteractionView } from '../../application/interactions.js';
import { atomicWrite, readBoundedFile } from '../journal/files.js';
import { digest, featureId } from './document.js';

export class MarkdownFeatureTaskNotes implements FeatureTaskNotesPort {
  private directory: string;
  private ensureDirectory: (path: string) => Promise<void>;
  constructor(directory: string, ensureDirectory: (path: string) => Promise<void>) { this.directory = directory; this.ensureDirectory = ensureDirectory; }
  private path(note: FeatureTaskProjection) {
    if (!featureId.test(note.identity.featureId) || !featureId.test(note.identity.id) ||
      (note.identity.pendingId !== null && !featureId.test(note.identity.pendingId)) || note.link !== featureTaskLink(note.identity))
      throw Error('Invalid feature Task note path.');
    return join(this.directory, note.link);
  }
  async read(note: FeatureTaskProjection): Promise<FeatureTaskDocument | undefined> {
    const path = this.path(note);
    await this.ensureDirectory(dirname(path));
    try {
      const markdown = await readBoundedFile(path, 65536);
      return { markdown, revision: digest(markdown) };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async ensure(note: FeatureTaskProjection, markdown: string, legacy?: { record: FeatureRecord; view: InteractionView }) {
    const current = await this.read(note);
    if (current) {
      if (legacy && current.markdown === legacyQuestion(legacy.record, legacy.view)) await this.write(note, current, markdown);
      return;
    }
    await this.create(this.path(note), markdown);
  }
  async write(note: FeatureTaskProjection, previous: FeatureTaskDocument, markdown: string) {
    if (previous.markdown === markdown) return true;
    const current = await this.read(note);
    if (!current || current.revision !== previous.revision) return false;
    await atomicWrite(this.path(note), markdown);
    return true;
  }
  private async create(path: string, markdown: string) {
    await this.ensureDirectory(dirname(path));
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
      await handle.writeFile(markdown);
      await handle.sync();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    finally { await handle?.close(); }
  }
  async attention(record: FeatureRecord, execution: NonNullable<ReturnType<FeatureQueuePort['inspect']>>) {
    if (!featureId.test(record.id)) throw Error('Invalid feature Task note identity.');
    const request = execution.request;
    const held = request && ['readiness', 'needs_rework', 'waiting_input', 'escalated'].includes(request.phase);
    if (!held && !['failed', 'interrupted', 'unavailable'].includes(execution.status)) return;
    const metadata = { schemaVersion: 1, type: 'Task', featureId: record.id, sessionId: record.sessionId, status: 'blocked', action: 'manual', executable: false, capturedAt: record.updatedAt };
    const findings = request?.findings.filter(finding => finding.status === 'open').map(finding => '- ' + finding.message.replace(/[\r\n]/g, ' ')).join('\n');
    const markdown = '---\n' + stringify(metadata) + '---\n# Task: action required\n\n' +
      (execution.error ?? 'The worker cannot continue this request with its currently approved input and checks.') + '\n\n' +
      (findings ? '## Checks to resolve\n\n' + findings + '\n\n' : '') +
      '## Next step\n\nInspect the [original request](../../' + encodeURIComponent(record.name) + ') and its saved evidence. ' +
      (request ? 'The [request checks](../../_gates/' + record.id + '/request.md) describe the current hold. ' : '') +
      'For changed instructions or approved files, copy the feature template into a new request and set that request to ready. ' +
      'A held gate cannot be approved by editing this Task or the generated gate evidence. ' +
      'This saved checkpoint may no longer be active; the original request records its current state. This informational Task accepts no automatic command; a separately generated answer or continuation Task explains when a reply can resume saved work.\n';
    const link = `_tasks/${record.id}/attention.md`;
    await this.create(join(this.directory, link), markdown);
    return link;
  }
}

function legacyQuestion(record: FeatureRecord, view: InteractionView) {
  const pending = view.pending;
  if (!pending) return '';
  const metadata = { schemaVersion: 1, featureId: record.id, sessionId: record.sessionId, phase: view.phase, revision: view.revision, pendingId: pending.id, turnId: pending.turnId };
  return '---\n' + stringify(metadata) + '---\n# Operator input checkpoint\n\n' + pending.message + '\n' +
    (pending.choices?.length ? '\n## Choices\n\n' + pending.choices.map(choice => '- ' + choice.id + ': ' + choice.label).join('\n') + '\n' : '') +
    (pending.reason ? '\n## Escalation reason\n\n' + pending.reason + '\n' : '') +
    '\nThis worker-generated question snapshot may already have been answered or cancelled. Consult the request’s current werk.interaction metadata or the worker interaction controls for its current state. Editing this file does not answer or resume the task. Use the worker interaction controls with this pending ID and current revision. The accepted request body and approved files remain frozen.\n';
}
