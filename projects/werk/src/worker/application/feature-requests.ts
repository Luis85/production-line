import { validateModelSelection, type ModelSelection, type ModelEffort } from './model-selection.js';
import { featureRequestReference, validateFeatureRequestReference, type FeatureRequestReference } from './feature-request-reference.js';
import { SerializedOperations } from '../../shared/serialized-operations.js';
import type { WorkerRequest, RequestPhase } from './request-gates.js';
import { FeatureTaskNotes, type FeatureTaskProjection, type FeatureTaskNotesPort } from './feature-task-notes.js';
import type { InteractionView, InteractionCommand } from './interactions.js';
import type { RunSnapshot, ProviderUsage } from './run-evidence.js';
import { manageFeature, type FeatureDocumentPort, type FeatureActionResult } from './feature-management.js';
import { DomainError } from '../../shared/errors.js';
import { randomUUID } from 'node:crypto';
import { publishFeatureInteraction, type FeatureIntakeReceipt } from './feature-interaction-intake.js';
import { reconcileFeatureSource } from './feature-source.js';
import { featureInputHash, acceptedFeatureHash, featureTaskIdentity, type FeatureMarkdownCommand, type FeatureCommandReceipt, type FeatureSourceIssue } from './feature-markdown.js';
import type { RequestCommand } from './request-gates.js';

export interface FeatureGateProjection {
  delivery?: { runId: string; status: string; phase: string; reason: string; waitingFor: string | null; controls: string[]; checkpoint?: { branch: string; candidateCommit: string } };
  requestId: string; revision: number; inputRevision: number; phase: RequestPhase;
  policyId: string; policyVersion: number; policyDigest: string;
  ready: 'pass' | 'fail' | 'unknown' | 'not_evaluated'; done: 'pass' | 'fail' | 'unknown' | 'not_evaluated';
  link: string; questions: string; gaps: string;
}
export interface FeatureExecutionEvidence {
  runId: string; attempt: number; before: RunSnapshot; after?: RunSnapshot;
  usage?: ProviderUsage; durationMs?: number | null; queueDurationMs?: number | null;
}
export interface FeatureExecutionLinks {
  runId: string; attempt: number; before: string; after?: string; completedAt?: string;
  result?: string; patch?: string;
}
export interface FeatureInput { title: string; mode: 'chat' | 'patch'; provider: string; model?: string; effort?: ModelEffort; message: string; paths?: string[]; priority: number; definitionId?: string; definitionRef?: string; agent?: string; useInstructionsOnly?: boolean; requestSchema?: 'worker.request/v1'; qualityProfile?: string; dependsOn?: string[]; criteria?: string[]; sectionNames?: string[]; }
export interface FeatureRecord { questions?: { id: string; message: string; blocking: boolean; criterionId?: string; active?: boolean }[]; semanticRevision?: number; sourceRevision?: string; sourceIssue?: FeatureSourceIssue; pendingInput?: FeatureInput; pendingInputHash?: string; commandReceipts?: FeatureCommandReceipt[]; managedHash?: string; selection?: ModelSelection; feature?: FeatureRequestReference; id: string; name: string; source: 'folder' | 'orchestrator'; taskId: string; sessionId: string; input?: FeatureInput; inputHash: string; submitted: boolean; status: string; createdAt: string; updatedAt: string; error?: string; result?: string; patch?: string; attempt?: number; archived?: boolean; taskNote?: FeatureTaskProjection; attention?: string; execution?: FeatureExecutionLinks; executionDirectory?: string; gates?: FeatureGateProjection; executionStatus?: string; interaction?: { phase: string; revision: number; pendingId?: string; link?: string }; }
export interface FeatureIndex { intakeReceipts?: FeatureIntakeReceipt[]; version: 1; owner: string; records: FeatureRecord[]; }
export interface FeatureFile { intent?: 'draft' | 'submit'; schema?: string; commands?: FeatureMarkdownCommand[]; managedHash?: string; name: string; revision: string; id?: string; status?: string; source?: string; shared?: boolean; input?: FeatureInput; error?: string; }
export interface FeatureFolderPort {
  directory: string;
  documents: FeatureDocumentPort;
  taskNotes?: FeatureTaskNotesPort;
  load(): Promise<FeatureIndex>;
  open(owner: string): Promise<void>;
  scan(): Promise<FeatureFile[]>;
  save(index: FeatureIndex): Promise<void>;
  update(file: FeatureFile, record: FeatureRecord, inputChanged: boolean): Promise<boolean>;
  createRemote(record: FeatureRecord, title: string, markdown: string): Promise<void>;
  evidence(record: FeatureRecord, evidence: FeatureExecutionEvidence): Promise<FeatureExecutionLinks>;
  question?(record: FeatureRecord, view: InteractionView): Promise<void>;
  gates?(record: FeatureRecord, request: WorkerRequest): Promise<FeatureGateProjection>;
  result(record: FeatureRecord, text: string, patch?: string): Promise<void>;
  report(value: { records: FeatureRecord[]; errors: { file: string; message: string }[] }): Promise<void>;
  close(): Promise<void>;
}
export interface FeatureQueuePort {
  reprioritize?(record: FeatureRecord, priority: number): Promise<boolean>;
  source?(record: FeatureRecord, issue: FeatureSourceIssue | null): Promise<void>;
  revise?(record: FeatureRecord, input: FeatureInput, semanticHash: string): Promise<boolean>;
  request?(record: FeatureRecord, command: RequestCommand): Promise<unknown>;
  selection?(input: FeatureInput): ModelSelection;
  reference?(sessionId: string): FeatureRequestReference | undefined;
  interact?(record: FeatureRecord, command: InteractionCommand): Promise<unknown>;
  control?(record: FeatureRecord, action: 'cancel' | 'retry'): Promise<unknown>;
  submit(record: FeatureRecord): Promise<void>;
  /** Report a definition selection that admission would refuse, before the request is reserved. Admission still checks it. */
  admissionIssue?(input: FeatureInput): string | undefined;
  inspect(record: FeatureRecord): { status: string; text?: string; patch?: string; error?: string; evidence?: FeatureExecutionEvidence; interaction?: InteractionView; request?: WorkerRequest } | undefined;
}
const fingerprint = featureInputHash;
const terminal = new Set(['completed', 'review', 'failed', 'cancelled']);
/** Files are intake and lifecycle records. The existing worker queue owns execution. */
export class FeatureRequests {
  private notes?: FeatureTaskNotes;
  private index: FeatureIndex = { version: 1, owner: '', records: [] };
  private observed = new Map<string, string>();
  private scannedFiles: FeatureFile[] = [];
  private dependencies: { id: string; dependsOn: string[] }[] = [];
  dependencyInputs() { return structuredClone(this.dependencies); }
  private errors: { file: string; message: string }[] = [];
  private readonly work = new SerializedOperations(); private scanning?: Promise<void>; private stopped = false;
  private initialized = false; private lastScan = 0; private lastSaved = ''; private fault: string | null = null;
  private folder: FeatureFolderPort; private queue: FeatureQueuePort; private pollMs: number; private canAdmit: () => boolean;
  constructor(folder: FeatureFolderPort, queue: FeatureQueuePort, pollMs = 1000, canAdmit = () => true) { this.folder = folder; this.queue = queue; if (folder.taskNotes) this.notes = new FeatureTaskNotes(folder.taskNotes, queue); this.pollMs = pollMs; this.canAdmit = canAdmit; }
  private reference(record: FeatureRecord): FeatureRequestReference {
    const reference = record.feature ?? (record.source === 'orchestrator' ? this.queue.reference?.(record.sessionId) : undefined);
    return reference ? { ...validateFeatureRequestReference(reference), sourcePath: record.name } : featureRequestReference({ id: record.source === 'orchestrator' ? record.taskId : record.id, source: record.source === 'orchestrator' ? 'orchestrator' : 'folder', scope: record.source === 'orchestrator' ? 'legacy-worker-assignment' : this.folder.directory, sourcePath: record.name });
  }
  referenceForSession(sessionId: string, existingKey?: string) {
    const record = this.index.records.find(item => item.sessionId === sessionId);
    if (!record) return undefined;
    const reference = this.reference(record);
    return record.submitted || reference.key === existingKey ? reference : undefined;
  }
  publishInteraction(id: string, input: FeatureInput, markdown: string) { return this.exclusive(() => publishFeatureInteraction(this.index, this.folder.documents, id, input, markdown, () => this.persist())); }
  async init() { this.index = await this.folder.load(); this.lastSaved = JSON.stringify(this.index); await this.folder.open(this.index.owner); this.initialized = true; }
  view() { return { enabled: true, directory: this.folder.directory, pollMs: this.pollMs, error: this.fault, errors: structuredClone(this.errors), records: this.index.records.map(({ input, taskNote, ...record }) => ({ ...record, priority: input?.priority, feature: this.reference(record), ...(taskNote ? { taskNote: { identity: { ...taskNote.identity }, link: taskNote.link, status: taskNote.submission?.outcome ?? 'open' } } : {}) })) }; }
  async list() { await this.tick(true); return { ...this.view(), files: (this.index.records.length ? await this.folder.scan() : this.scannedFiles).map(({ input, ...file }) => ({ ...file, status: this.index.records.find(item => item.name === file.name)?.status ?? file.status ?? (file.intent === 'submit' ? 'ready' : file.intent), sourceIssue: this.index.records.find(item => item.name === file.name)?.sourceIssue, title: input?.title, priority: input?.priority, mode: input?.mode, provider: input?.provider, archived: this.index.records.find(item => item.name === file.name)?.archived ?? false })) }; }
  async action(input: unknown): Promise<FeatureActionResult> {
    return this.exclusive(async () => {
      if (this.stopped) throw new DomainError('unavailable', 'Worker is stopping.');
      const body = input as { name: string; action: string };
      const readOnly = ['get', 'validate', 'result'].includes(body?.action);
      if (readOnly) await this.reconcile(false);
      if (body?.action === 'submit' || body?.action === 'retry') {
        const file = (await this.folder.scan()).find(file => file.name === body.name);
        if (file?.shared) throw new DomainError('conflict', 'Shared Git requests use shared intake. Cancel any unfinished local task and restore its shared request from Git before connecting shared intake; local submit and retry cannot process it.');
      }
      if (body?.action === 'retry') {
        // Capture the just-finished run before this management action replaces it.
        // This does not rewrite the source file/revision used by the caller's guard.
        const record = this.index.records.find(item => item.name === body.name);
        if (record?.submitted) { await this.synchronizeExecution(record); await this.persist(); }
      }
      let result = await manageFeature(input, { documents: this.folder.documents, index: this.index, queue: this.queue, persist: () => this.persist() });
      if (!readOnly) await this.reconcile(false);
      if (body.action !== 'delete' && !['get', 'validate', 'result'].includes(body.action)) result = { ...await this.folder.documents.read(body.name), record: this.index.records.find(item => item.name === body.name) ?? null };
      return result;
    });
  }
  private exclusive<T>(action: () => Promise<T>) {
    return this.work.run(action);
  }
  private async persist() { const serialized = JSON.stringify(this.index); if (serialized !== this.lastSaved) { await this.folder.save(this.index); this.lastSaved = serialized; } }
  private change(record: FeatureRecord, status: string, error?: string) {
    if (record.status !== status || record.error !== error) { record.status = status; record.error = error; record.updatedAt = new Date().toISOString(); }
  }
  tick(force = false): Promise<void> {
    if (this.stopped || !this.initialized) return Promise.resolve();
    if (this.scanning) return this.scanning;
    if (!force && Date.now() - this.lastScan < this.pollMs) return Promise.resolve();
    this.lastScan = Date.now();
    this.scanning = this.exclusive(async () => { try { await this.reconcile(this.canAdmit()); this.fault = null; } catch { this.fault = 'Feature folder could not be synchronized. Check its permissions, state and available disk space.'; } }).finally(() => { this.scanning = undefined; });
    return this.scanning;
  }
  private async reconcile(admit: boolean) {
    const files = await this.folder.scan(); this.scannedFiles = files; this.errors = [];
    this.dependencies = files.filter(file => file.id && file.input).map(file => ({ id: file.id!, dependsOn: file.input?.dependsOn ?? [] }));
    const stable = new Set<string>();
    const ids = new Map<string, number>();
    for (const file of files) if (file.id) ids.set(file.id, (ids.get(file.id) ?? 0) + 1);
    const seen = new Set(files.map(file => file.name));
    for (const name of this.observed.keys()) if (!seen.has(name)) this.observed.delete(name);
    for (const file of files) {
      const previous = this.observed.get(file.name); this.observed.set(file.name, file.revision);
      if (previous === file.revision) stable.add(file.name);
      if (file.error) { this.errors.push({ file: file.name, message: file.error }); continue; }
      // Shared notes belong to the Git intake even when an older worker retained
      // a local record. Keep that history available for cancellation and inspection.
      if (file.shared) {
        const retained = this.index.records.find(record => record.id === file.id || record.name === file.name);
        if (retained) this.errors.push({ file: file.name, message: 'Shared Git request has retained local history. Local admission and source updates are blocked. Cancel any unfinished local task, restore the shared request from Git, then connect shared intake.' });
        else if (file.status === 'ready') this.errors.push({ file: file.name, message: 'Shared Git request: connect shared intake to process it. The local feature folder never claims shared requests.' });
        continue;
      }
      if (file.id && ids.get(file.id)! > 1) { this.errors.push({ file: file.name, message: 'Duplicate feature ID. Keep one canonical file per request; give copied requests a new unique ID.' }); continue; }
      let record = this.index.records.find(item => item.id === file.id);
      const atName = this.index.records.find(item => item.name === file.name);
      if (atName && record !== atName && file.id) { this.errors.push({ file: file.name, message: 'This filename already belongs to another request. Restore its ID or use a new filename.' }); continue; }
      record ??= !file.id ? atName : undefined;
      if (!record) {
        if (file.source === 'orchestrator' || !(file.intent || ['draft', 'ready'].includes(file.status ?? ''))) { this.errors.push({ file: file.name, message: 'Unrecognized lifecycle record. New requests need intent: draft or submit (legacy: explicit status: draft or ready).' }); continue; }
        if (!admit || (file.intent ? file.intent !== 'submit' : file.status !== 'ready') || previous !== file.revision) continue;
        if (!file.input) continue;
        const issue = this.queue.admissionIssue?.(file.input);
        if (issue) { this.errors.push({ file: file.name, message: issue.slice(0, 500) }); continue; }
        if (this.index.records.length >= 1000) { this.errors.push({ file: file.name, message: 'Feature index reached 1,000 records. Use a new worker state and folder for further requests.' }); continue; }
        let selection: ModelSelection | undefined;
        try { if (this.queue.selection) selection = validateModelSelection(this.queue.selection(file.input)); }
        catch (error) { this.errors.push({ file: file.name, message: error instanceof Error ? error.message : 'Choose a configured model before accepting this request.' }); continue; }
        const id = file.id ?? randomUUID(), at = new Date().toISOString();
        record = { id, ...(selection ? { selection } : {}), feature: featureRequestReference({ id, source: 'folder', scope: this.folder.directory, sourcePath: file.name }), name: file.name, source: 'folder', ...featureTaskIdentity(id, file.input.mode), ...(this.index.intakeReceipts?.find(receipt => receipt.id === id) ? { taskId: this.index.intakeReceipts.find(receipt => receipt.id === id)!.taskId, sessionId: this.index.intakeReceipts.find(receipt => receipt.id === id)!.sessionId } : {}), input: structuredClone(file.input), inputHash: fingerprint(file.input), submitted: false, semanticRevision: 1, sourceRevision: file.revision, status: 'waiting', createdAt: at, updatedAt: at };
        this.index.records.push(record); await this.persist();
      }
      record.name = file.name;
      const changed = record.source === 'folder' && !!file.input && fingerprint(file.input) !== acceptedFeatureHash(record);
      if (changed && !record.submitted) { try { if (this.queue.inspect(record)) record.submitted = true; } catch { /* No retained task: source revision remains held until validated. */ } }
      if (!record.submitted && record.status !== 'cancelled' && admit && !changed) {
        // Retry an earlier failed reservation write before any admission or public ID update.
        await this.persist();
        // Publish the durable ID before admitting work; an interrupted save can be retried safely.
        if (!await this.folder.update(file, record, changed)) continue;
        try { await this.queue.submit(record); record.submitted = true; this.change(record, 'queued'); }
        catch (error) { this.change(record, 'waiting', error instanceof Error ? error.message.slice(0, 500) : 'Task could not enter the queue.'); }
        await this.persist();
      }
    }
    for (const record of this.index.records) {
      const file = files.find(file => file.id === record.id || file.name === record.name);
      const local = record.source === 'folder' && !file?.shared;
      if (record.source === 'folder') {
        const issue: FeatureSourceIssue | undefined = !file ? { code: 'missing_source', reason: 'File missing. Restore the canonical request to continue; execution is held.' }
          : file.shared ? { code: 'invalid_source', reason: 'Shared Git now owns this source. Resolve the retained local assignment before continuing.' }
          : file.error ? { code: 'invalid_source', reason: file.error }
          : file.id && ids.get(file.id)! > 1 ? { code: 'duplicate_identity', reason: 'Duplicate request ID. Keep one canonical source before continuing.' }
          : file.id && file.id !== record.id ? { code: 'invalid_source', reason: 'The source identity changed. Restore its registered request ID.' } : undefined;
        try { await reconcileFeatureSource(record, file, issue, this.queue, () => this.persist(), !!file && stable.has(file.name)); }
        catch (error) { this.errors.push({ file: record.name, message: error instanceof Error ? error.message.slice(0, 500) : 'Source reconciliation could not finish.' }); }
        if (record.sourceIssue) this.errors.push({ file: record.name, message: record.sourceIssue.reason });
      }
      if (record.submitted) await this.synchronizeExecution(record, local && !record.sourceIssue, local);
    }
    await this.persist();
    // Refresh revisions after intake publication. Updates preserve the current Markdown body.
    const fresh = this.index.records.length ? await this.folder.scan() : files;
    for (const file of fresh) {
      if (file.error || file.shared || (file.id && ids.get(file.id)! > 1)) continue;
      const record = this.index.records.find(item => item.id === file.id || (!file.id && item.name === file.name));
      if (record && record.name === file.name) await this.folder.update(file, record, record.source === 'folder' && !!file.input && fingerprint(file.input) !== acceptedFeatureHash(record));
    }
    await this.folder.report({ records: this.index.records, errors: this.errors });
  }
  private async synchronizeExecution(record: FeatureRecord, admit = false, local = record.source === 'folder') {
    if (admit && this.notes) {
      try {
        const error = await this.notes.consume(record, () => this.persist());
        if (error) this.errors.push({ file: record.taskNote?.link ?? record.name, message: error });
      } catch (error) {
        this.errors.push({ file: record.taskNote?.link ?? record.name, message: error instanceof Error ? error.message.slice(0, 500) : 'Task reply could not be read.' });
      }
    }
    const current = this.queue.inspect(record);
    if (!current) { this.change(record, 'unavailable', 'Task history is no longer retained. This request will not be submitted again.'); return; }
    const phase = current.request?.phase;
    // Preserve established execution labels; the independently persisted gate projection
    // owns readiness, rework and completion authority without relabeling a known attempt.
    const held = phase && ['readiness', 'needs_rework', 'waiting_input', 'escalated', 'review'].includes(phase);
    this.change(record, held ? phase === 'readiness' ? 'needs_rework' : phase : current.status, current.error);
    if (record.sourceIssue && !['done', 'cancelled'].includes(phase ?? '') && !['running', 'cancelled', 'completed'].includes(current.status)) this.change(record, 'waiting_input', record.sourceIssue.reason);
    const questions = current.request?.findings.filter(finding => finding.kind === 'question').map(finding => ({ id: finding.id, message: finding.message, blocking: finding.blocking, active: finding.status === 'open', ...(finding.ruleId ? { criterionId: finding.ruleId } : {}) })) ?? [];
    if (current.interaction?.pending) questions.push({ id: current.interaction.pending.id, message: current.interaction.pending.message, blocking: true, active: true });
    record.questions = [...(record.questions ?? []).filter(previous => !questions.some(question => question.id === previous.id)).map(previous => ({ ...previous, active: false })), ...questions];
    if (current.request && this.folder.gates) {
      record.gates = await this.folder.gates(record, current.request);
      record.executionStatus = current.status;
    } else { delete record.gates; delete record.executionStatus; }
    if (current.interaction) {
      const view = current.interaction;
      record.interaction = { phase: view.phase, revision: view.revision, ...(view.pending ? { pendingId: view.pending.id, link: `_questions/${record.id}/${view.pending.id}.md` } : {}) };
      if (view.pending && !this.notes) await this.folder.question?.(record, view);
    } else delete record.interaction;
    if (local && this.notes) {
      try { await this.notes.project(record, current, this.index.owner, () => this.persist()); }
      catch (error) { this.errors.push({ file: record.taskNote?.link ?? record.name, message: error instanceof Error ? error.message.slice(0, 500) : 'Task note could not be saved.' }); }
    }
    const currentExecution = !current.request || current.request.execution?.inputRevision === current.request.inputRevision
      && (!current.evidence || current.request.execution.runId === current.evidence.runId);
    if (current.evidence && currentExecution) {
      record.execution = await this.folder.evidence(record, current.evidence);
      record.executionDirectory = `_results/${record.id}/`;
    } else delete record.execution;
    // Latest-result pointers must not describe a retry or follow-up that has not finished.
    // Its earlier immutable execution exports remain available in the execution directory.
    const publishResult = currentExecution && (!current.request || !['prepared', 'running'].includes(current.request.execution!.status)) && terminal.has(current.status) && current.text !== undefined;
    if (!publishResult) { delete record.result; delete record.patch; }
    if (publishResult) {
      await this.folder.result(record, current.request?.delivery?.review?.markdown ?? current.text!, current.patch);
      record.result = `_results/${record.id}.md`;
      if (current.patch) record.patch = `_results/${record.id}.patch`; else delete record.patch;
      if (record.execution?.after) {
        record.execution.result = `_results/${record.id}/${record.execution.runId}.md`;
        if (current.patch) record.execution.patch = `_results/${record.id}/${record.execution.runId}.patch`;
      }
    }
  }
  async rememberRemote(task: { id: string; title: string; criteria: string[]; attempt: number; requirementRef?: string; }, feature?: FeatureRequestReference) {
    const reference = feature && validateFeatureRequestReference(feature);
    await this.exclusive(async () => {
      let record = this.index.records.find(item => item.source === 'orchestrator' && item.taskId === task.id);
      if (!record) {
        if (this.index.records.length >= 1000) throw Error('Feature index reached 1,000 records.');
        const at = new Date().toISOString(), id = 'remote-' + task.id;
        record = { id, ...(reference ? { feature: reference } : {}), name: id + '.md', source: 'orchestrator', taskId: task.id, sessionId: id, submitted: true, inputHash: '', status: 'queued', attempt: task.attempt, createdAt: at, updatedAt: at };
        this.index.records.push(record);
      }
      if (reference) {
        if (record.feature && record.feature.key !== reference.key) throw new DomainError('conflict', 'This assignment belongs to another Feature Request.');
        record.feature ??= reference;
      }
      if (record.attempt !== task.attempt) { delete record.result; delete record.patch; delete record.execution; this.change(record, 'queued'); }
      record.attempt = task.attempt;
      await this.persist();
      await this.folder.createRemote(record, task.title, `# ${task.title}\n\n## Acceptance criteria\n\n${task.criteria.map(value => '- ' + value).join('\n')}\n${task.requirementRef ? '\n## Requirement\n\n' + task.requirementRef + '\n' : ''}\nThis request is assigned by the orchestrator. Its lease and routing remain orchestrator-owned.\n`);
    });
  }
  async stopIntake() { this.stopped = true; await this.work.drain(); }
  async close() { await this.stopIntake(); if (!this.initialized) return; try { await this.reconcile(false); } finally { this.initialized = false; await this.folder.close(); } }
}
