import { object, identifier } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import { canonicalJson, gateDigest } from './request-gates.js';
import { sharedHash } from './shared-feature-notes.js';
import type { SharedFeatureRecord, SharedIntakePorts, LifecycleWrite } from './shared-feature-state.js';
import type { SharedReadyReviewAnswerCommand, SharedReadyReviewAnswerSubject, SharedReadyReviewAnswerAcknowledgement } from './shared-ready-review-answer-contracts.js';
const fields = ['action', 'projectId', 'requestId', 'operationId', 'expectedGeneration', 'expectedReviewOperationId', 'expectedReviewDigest', 'expectedSourceCommit', 'expectedSourceRevision', 'answer'];
function conflict(message: string): never { throw new DomainError('conflict', message); }
export function validateSharedReadyReviewAnswer(value: unknown): SharedReadyReviewAnswerCommand {
  const body = object(value, 'Ready Check answer', fields);
  if (body.action !== 'answer_ready_review' || !Number.isSafeInteger(body.expectedGeneration) || Number(body.expectedGeneration) < 1 ||
      typeof body.expectedReviewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedReviewDigest) ||
      typeof body.expectedSourceRevision !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedSourceRevision) ||
      typeof body.expectedSourceCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(body.expectedSourceCommit) ||
      typeof body.answer !== 'string' || !body.answer.trim() || body.answer.length > 8000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(body.answer) || body.answer.includes('<!-- werk:') || body.answer.includes('<!-- /werk:'))
    throw new DomainError('invalid_input', 'Answer the current Ready Check with nonempty text of at most 8,000 characters and its exact source/review identity.');
  return { action: 'answer_ready_review', requestId: identifier(body.requestId, 'Feature Request ID'), operationId: identifier(body.operationId, 'operationId'),
    ...(body.projectId === undefined ? {} : { projectId: identifier(body.projectId, 'projectId') }), expectedGeneration: Number(body.expectedGeneration),
    expectedReviewOperationId: identifier(body.expectedReviewOperationId, 'Ready Check operation'), expectedReviewDigest: body.expectedReviewDigest,
    expectedSourceCommit: body.expectedSourceCommit, expectedSourceRevision: body.expectedSourceRevision, answer: body.answer.replace(/\r\n?/g, '\n').trim() };
}
function readyReviewAnswerSubject(record: SharedFeatureRecord): SharedReadyReviewAnswerSubject | undefined {
  const state = record.readyReviewState;
  if (!state || record.status !== 'waiting_ready_input' || state.status !== 'waiting_input' || state.implementationReady || !state.attempt || !record.claimed || record.submitted) return;
  return { expectedGeneration: state.generation, expectedReviewOperationId: state.input.operationId, expectedReviewDigest: gateDigest(state.input), expectedSourceCommit: record.sourceCommit, expectedSourceRevision: record.remoteRevision };
}
export function readyReviewAnswerView(record: SharedFeatureRecord, workerId: string) {
  if (record.owner !== workerId) return {};
  const receipt = record.readyReviewAnswers?.filter(item => item.subject.expectedGeneration === record.readyReviewState?.generation).at(-1), subject = readyReviewAnswerSubject(record);
  return { ...(subject && (!record.pending || receipt?.status === 'pending' && record.pending.operationId === receipt.writeOperationId) ? { answerSubject: subject } : {}),
    ...(receipt ? { answerPublication: { operationId: receipt.operationId, status: receipt.status } } : {}) };
}
/** The same confirmed Git outbox may publish an answer without advancing the consumer's prior-source fence. */
export function acknowledgeReadyReviewAnswer(record: SharedFeatureRecord, write: LifecycleWrite): boolean {
  const receipt = record.readyReviewAnswers?.find(item => item.writeOperationId === write.operationId);
  if (!receipt) return false;
  if (receipt.status !== 'pending' || receipt.writeDigest !== gateDigest(write)) conflict('The saved Ready Check answer publication identity changed. Restore its worker journal.');
  receipt.status = 'published'; receipt.publishedRevision = sharedHash(write.request.content);
  return true;
}
export function rejectReadyReviewAnswer(record: SharedFeatureRecord, write: LifecycleWrite): boolean {
  const receipt = record.readyReviewAnswers?.find(item => item.status === 'pending' && item.writeOperationId === write.operationId);
  if (!receipt) return false;
  receipt.status = 'rejected'; return true;
}
/** Answer-only publication never consumes the pushed response or dispatches another review/implementation. */
export async function publishSharedReadyReviewAnswer(options: {
  record: SharedFeatureRecord; workerId: string; command: SharedReadyReviewAnswerCommand; ports: SharedIntakePorts;
  signal: AbortSignal; save(): Promise<void>; flush(): Promise<void>;
}): Promise<SharedReadyReviewAnswerAcknowledgement> {
  const { record, workerId, command, ports, signal, save, flush } = options;
  if (record.owner !== workerId || !record.claimed || command.requestId !== record.id) conflict('This worker does not own the requested Ready Check.');
  const digest = gateDigest(command), previous = record.readyReviewAnswers?.find(item => item.operationId === command.operationId);
  const acknowledgement: SharedReadyReviewAnswerAcknowledgement = { requestId: record.id, operationId: command.operationId, status: 'published' };
  if (previous) {
    if (previous.digest !== digest) conflict('This Ready Check answer operation was already used for different input. Retry its exact saved answer.');
    if (previous.status === 'published') return acknowledgement;
    if (previous.status === 'rejected') conflict('The canonical Feature Request changed before this answer was published. Refresh its latest Ready Check.');
    if (!record.pending || record.pending.operationId !== previous.writeOperationId || gateDigest(record.pending) !== previous.writeDigest) conflict('The saved Ready Check answer outbox is unavailable. Restore the worker journal before retrying.');
  } else {
    const subject = readyReviewAnswerSubject(record);
    if (!subject || ports.inspect(record.taskId!)) conflict('Only an owned Ready Check waiting for input before implementation may be answered here.');
    const supplied = Object.fromEntries(Object.keys(subject).map(key => [key, command[key as keyof SharedReadyReviewAnswerSubject]]));
    if (canonicalJson(subject) !== canonicalJson(supplied)) conflict('The Ready Check or its canonical source changed. Refresh before answering.');
    if (record.pending || record.publication !== 'synced') conflict('Finish the previous Feature Request publication before answering this Ready Check.');
    if (record.readyReviewAnswers?.some(item => item.subject.expectedGeneration === subject.expectedGeneration && item.status !== 'rejected')) conflict('An answer is already saved for this Ready Check. Retry its exact operation or refresh the next review.');
    if ((record.readyReviewAnswers?.length ?? 0) >= 32) throw new DomainError('unavailable', 'This Feature Request retains 32 answer operations. Continue through its canonical Markdown history.');
    if (!ports.readyReviewResponse || !ports.readyReviewAnswer) throw new DomainError('unavailable', 'This worker cannot safely publish Ready Check answers.');
    const repository = ports.repository(record.binding, record.workflow), head = await repository.head(signal), source = await repository.readBlob(head, record.sourcePath, signal);
    signal.throwIfAborted();
    if (source === null || sharedHash(source) !== subject.expectedSourceRevision) conflict('The canonical Feature Request changed before this answer. Refresh its latest Ready Check.');
    const response = ports.readyReviewResponse(source, record);
    if (response.status !== 'waiting_ready_input') conflict('This Ready Check source is no longer waiting for an answer. Refresh the Feature Request.');
    const content = ports.readyReviewAnswer(source, record, command.answer);
    if (Buffer.byteLength(content) > 65536) throw new DomainError('invalid_input', 'The answered Feature Request exceeds 64 KiB. Shorten the canonical request before continuing.');
    const write: LifecycleWrite = { operationId: 'ready-answer-' + sharedHash(record.id + command.operationId + digest).slice(0, 48), request: { path: record.sourcePath, expectedRevision: subject.expectedSourceRevision, content }, artifacts: [] };
    const receipts = record.readyReviewAnswers;
    record.readyReviewAnswers = [...(receipts ?? []), { operationId: command.operationId, digest, subject, writeOperationId: write.operationId, writeDigest: gateDigest(write), status: 'pending' }];
    record.pending = write; record.publication = 'pending';
    // A lost save acknowledgement retains the immutable in-memory intent; every retry persists it before Git.
  }
  await save();
  await flush();
  const receipt = record.readyReviewAnswers?.find(item => item.operationId === command.operationId);
  if (receipt?.status !== 'published') throw new DomainError('unavailable', 'The Ready Check answer is saved but its Git publication is not confirmed. Retry this same operation.');
  return acknowledgement;
}


/** Recovery accepts only bounded, internally consistent answer receipts and their immutable pending outbox. */
export function validateSharedReadyReviewAnswers(record: SharedFeatureRecord): void {
  const values = record.readyReviewAnswers;
  if (values === undefined) {
    if (record.pending?.operationId.startsWith('ready-answer-')) throw Error('Missing Ready Check answer receipt.');
    return;
  }
  if (!Array.isArray(values) || values.length > 32 || new Set(values.map(item => item?.operationId)).size !== values.length) throw Error('Invalid Ready Check answer history.');
  for (const item of values) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['operationId', 'digest', 'subject', 'writeOperationId', 'writeDigest', 'status', 'publishedRevision'].includes(key)) ||
        typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/.test(item.digest) || typeof item.writeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(item.writeDigest) ||
        !['pending', 'published', 'rejected'].includes(item.status) || !item.subject || typeof item.subject !== 'object' || Array.isArray(item.subject) ||
        Object.keys(item.subject).sort().join(',') !== ['expectedGeneration', 'expectedReviewOperationId', 'expectedReviewDigest', 'expectedSourceCommit', 'expectedSourceRevision'].sort().join(',')) throw Error('Invalid Ready Check answer receipt.');
    identifier(item.operationId, 'Ready Check answer operation');
    validateSharedReadyReviewAnswer({ ...item.subject, action: 'answer_ready_review', requestId: record.id, operationId: item.operationId, answer: 'Validate saved subject.' });
    if (!record.readyReviewState || item.subject.expectedGeneration > record.readyReviewState.generation || item.writeOperationId !== 'ready-answer-' + sharedHash(record.id + item.operationId + item.digest).slice(0, 48) ||
        (item.status === 'published' ? typeof item.publishedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(item.publishedRevision) : item.publishedRevision !== undefined)) throw Error('Invalid Ready Check answer publication identity.');
    if (item.status === 'pending' && (!record.pending || record.pending.operationId !== item.writeOperationId || gateDigest(record.pending) !== item.writeDigest || canonicalJson(item.subject) !== canonicalJson(readyReviewAnswerSubject(record)))) throw Error('Invalid pending Ready Check answer outbox.');
  }
  if (record.pending?.operationId.startsWith('ready-answer-') && !values.some(item => item.status === 'pending' && item.writeOperationId === record.pending!.operationId)) throw Error('Missing pending Ready Check answer receipt.');
}
