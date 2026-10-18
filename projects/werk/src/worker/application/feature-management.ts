import { DomainError } from '../../shared/errors.js';
import { object, text } from '../../shared/validation.js';
import type { FeatureInput, FeatureIndex, FeatureQueuePort, FeatureRecord } from './feature-requests.js';
export interface FeatureDocumentPort {
  read(name: string): Promise<{ name: string; markdown: string; revision: string }>;
  validate(markdown: string): { input: FeatureInput; id: unknown; status: unknown; managed: boolean; gates?: { requestId: string; revision: number; inputRevision: number; policyDigest: string } };
  ready(markdown: string): string;
  write(name: string, markdown: string, revision?: string): Promise<{ name: string; markdown: string; revision: string }>;
  remove(name: string, revision: string): Promise<void>;
}
/** Transport result fields vary by action; accepted record and execution types remain explicit. */
export interface FeatureActionResult {
  name: string;
  markdown?: string;
  revision?: string;
  record?: FeatureRecord | null;
  execution?: (Omit<NonNullable<ReturnType<FeatureQueuePort['inspect']>>, 'status'> & { status: unknown }) | null;
  valid?: boolean;
  input?: FeatureInput;
  id?: unknown;
  status?: unknown;
  managed?: boolean;
  deleted?: boolean;
  retainedTaskId?: string | null;
}
export interface FeatureManagementContext {
  documents: FeatureDocumentPort; index: FeatureIndex; queue: FeatureQueuePort;
  persist(): Promise<void>;
}
const stopped = new Set(['completed', 'review', 'failed', 'cancelled', 'unavailable']);
function stoppedRequest(record: FeatureRecord, queue: FeatureQueuePort) {
  const current = queue.inspect(record);
  return current?.request ? ['done', 'failed', 'cancelled', 'interrupted'].includes(current.request.phase) : stopped.has(current?.status ?? record.status);
}
export async function manageFeature(input: unknown, context: FeatureManagementContext): Promise<FeatureActionResult> {
  const body = object(input, 'Feature command', ['action', 'name', 'markdown', 'revision']);
  const action = String(body.action), name = text(body.name, 'name', 200), { documents, index, queue } = context;
  if (!['get', 'validate', 'create', 'edit', 'submit', 'cancel', 'retry', 'archive', 'restore', 'delete', 'result'].includes(action)) throw new DomainError('invalid_input', 'Unknown feature action.');
  let atName = index.records.find(item => item.name === name);
  if (action === 'create') {
    if (atName) throw new DomainError('conflict', 'Filename belongs to a retained request. Choose a new filename.');
    const markdown = draft(body.markdown, documents);
    if (index.records.some(record => record.id === documents.validate(markdown).id)) throw new DomainError('conflict', 'Feature ID is already retained. Use a new ID or omit it.');
    return documents.write(name, markdown);
  }
  const file = await documents.read(name);
  // A filesystem rename can precede the watcher's next observation.
  if (!atName) {
    let id: unknown; try { id = documents.validate(file.markdown).id; } catch { /* Malformed drafts remain repairable. */ }
    if (id) atName = index.records.find(record => record.id === id);
  }
  if (action === 'get') return { ...file, record: atName ?? null };
  if (action === 'validate') {
    const parsed = documents.validate(file.markdown);
    // Accepted input keeps its frozen definition snapshot; only unaccepted requests are checked against current definitions.
    const issue = atName ? undefined : queue.admissionIssue?.(parsed.input);
    if (issue) throw new DomainError('invalid_input', issue);
    return { name, revision: file.revision, valid: true, ...parsed };
  }
  if (action === 'result') {
    if (!atName) return { name, record: null, execution: { status: documents.validate(file.markdown).status ?? 'ready' } };
    return { name, record: atName, execution: queue.inspect(atName) ?? null };
  }
  if (body.revision !== file.revision) throw new DomainError('conflict', 'Supply the current revision from feature get with --if-match.');
  if (atName?.source === 'orchestrator') throw new DomainError('conflict', 'This request is orchestrator-owned. Manage its assignment at the orchestrator.');
  if (action === 'edit' || action === 'submit') {
    if (atName) throw new DomainError('conflict', 'Accepted input is frozen. Create a new draft for different work.');
    const markdown = action === 'edit' ? draft(body.markdown, documents) : documents.ready(draft(file.markdown, documents));
    if (index.records.some(record => record.id === documents.validate(markdown).id)) throw new DomainError('conflict', 'Feature ID is already retained. Use a new ID or omit it.');
    return documents.write(name, markdown, file.revision);
  }
  if (action === 'delete') {
    if (atName && !stoppedRequest(atName, queue)) throw new DomainError('conflict', 'Cancel or finish the task before deleting its file.');
    await documents.remove(name, file.revision);
    return { name, deleted: true, retainedTaskId: atName?.taskId ?? null };
  }
  if (!atName) throw new DomainError('conflict', 'Submit this draft before managing its task.');
  const record: FeatureRecord = atName;
  if (action === 'retry') {
    const current = queue.inspect(record), request = current?.request;
    if (request) {
      const projection = documents.validate(file.markdown).gates;
      if (!projection || projection.requestId !== request.id || projection.revision !== request.revision || projection.inputRevision !== request.inputRevision || projection.policyDigest !== request.policyDigest)
        throw new DomainError('conflict', 'The file has stale request gate evidence. Inspect feature get and refresh the projection before retrying; an earlier admission may already have succeeded.');
      const ready = request.evaluations.findLast(evaluation => evaluation.stage === 'ready' && evaluation.inputRevision === request.inputRevision);
      const allowed = ['failed', 'cancelled', 'interrupted'].includes(current.status)
        && ['ready', 'failed', 'cancelled', 'interrupted'].includes(request.phase)
        && !request.recoveryHold && request.execution?.result?.type !== 'completed'
        && !['prepared', 'running'].includes(request.execution?.status ?? '')
        && ready?.passed && ready.inputHash === request.inputHash && ready.policyDigest === request.policyDigest;
      if (!allowed) throw new DomainError('conflict', 'This request is held by readiness or done checks, or already has a known result. Inspect its findings and use guarded request rework or candidate controls; feature retry cannot bypass those gates.');
      // The owning task's resume command rechecks its frozen readiness policy and
      // atomically binds a new interaction revision before another model invocation.
    }
  }
  // Admission may have succeeded before its acknowledgement was persisted.
  if (!record.submitted && queue.inspect(record)) record.submitted = true;
  if (action === 'archive' || action === 'restore') {
    if (!stoppedRequest(record, queue)) throw new DomainError('conflict', 'Cancel or finish the task before archiving.');
    record.archived = action === 'archive';
  } else if (action === 'cancel' && !record.submitted) { record.status = 'cancelled'; record.error = undefined; }
  else if (action === 'retry' && !record.submitted) {
    if (record.status !== 'cancelled') throw new DomainError('conflict', 'Waiting requests retry admission automatically.');
    record.status = 'waiting'; record.archived = false;
  } else {
    if (!queue.control) throw new DomainError('unavailable', 'Task controls are unavailable.');
    await queue.control(record, action as 'cancel' | 'retry');
    record.archived = false;
  }
  record.updatedAt = new Date().toISOString(); await context.persist();
  return { name, record: structuredClone(record) };
}
function draft(value: unknown, documents: FeatureDocumentPort) {
  text(value, 'markdown', 65536);
  const markdown = value as string, parsed = documents.validate(markdown);
  if (parsed.status !== 'draft' || parsed.managed) throw new DomainError('invalid_input', 'Create or edit status: draft requests without source/werk metadata. Use submit to queue them.');
  return markdown;
}
