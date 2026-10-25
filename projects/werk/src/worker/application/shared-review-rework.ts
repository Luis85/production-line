import { DomainError } from '../../shared/errors.js';
import { gateDigest, type RequestCommand } from './request-gates.js';
import { reviewReworkInput } from './remote-delivery-rework.js';
import { sharedHash } from './shared-feature-notes.js';
import { sharedTaskActive, type SharedFeatureRecord, type SharedIntakePorts, type SharedRepositoryPort } from './shared-feature-state.js';

/** Feedback is a candidate-bound continuation command, never permission to change accepted scope. */
export function reserveSharedReviewRework(record: SharedFeatureRecord, command: RequestCommand, ports: SharedIntakePorts) {
  if (command.action !== 'request_changes' || !command.note?.trim() || command.note.trim().length > 4000)
    throw new DomainError('invalid_input', 'Shared review feedback requires the saved request_changes command and 1–4,000 characters of feedback.');
  const digest = gateDigest(command), previous = record.reviewReworks?.find(item => item.command.operationId === command.operationId);
  if (previous) {
    if (previous.digest !== digest) throw new DomainError('conflict', 'This shared review operation ID belongs to different feedback.');
    return;
  }
  if (!record.claimed || !record.submitted || sharedTaskActive(record) || record.reviewReworks?.some(item => item.status !== 'dispatched'))
    throw new DomainError('conflict', 'Finish the current shared continuation before accepting another review feedback command.');
  if ((record.reviewReworks?.length ?? 0) >= 16) throw new DomainError('conflict', 'This shared request reached its bounded review history. Preserve it and create a successor request.');
  const request = ports.inspect(record.taskId!)?.request;
  if (!request || request.id !== command.requestId || !reviewReworkInput(request, command))
    throw new DomainError('conflict', 'Shared feedback must target the current recorded review candidate.');
  record.reviewReworks = [...(record.reviewReworks ?? []), { command: structuredClone(command), digest, status: 'pending_source' }];
  record.status = 'needs_rework'; record.error = null;
  record.progress = 'Your review feedback is saved. The worker will confirm it on the shared branch before starting rework.';
}

/** Source publication and dispatch are two persisted stages, replayed independently after a restart. */
export async function advanceSharedReviewRework(input: {
  record: SharedFeatureRecord; ports: SharedIntakePorts; repository: SharedRepositoryPort; signal: AbortSignal;
  save(): Promise<void>; publish(): Promise<void>;
}): Promise<boolean> {
  const { record, ports, repository, signal, save, publish } = input;
  const receipt = record.reviewReworks?.find(item => item.status !== 'dispatched');
  if (!receipt) return true;
  if (!ports.reviewRework) throw new DomainError('unavailable', 'This worker cannot dispatch recorded shared review feedback. Restore its execution coordinator.');
  if (receipt.status === 'pending_source') {
    await publish();
    receipt.status = 'pending_dispatch'; await save();
  }
  const current = await repository.readBlob(await repository.head(signal), record.sourcePath, signal);
  if (current === null || sharedHash(current) !== record.remoteRevision || record.pending)
    throw new DomainError('conflict', 'The shared feedback source changed before dispatch. Preserve the teammate edit and reconcile the saved source before continuing.');
  await ports.reviewRework(record, structuredClone(receipt.command));
  receipt.status = 'dispatched'; record.status = 'queued'; record.done = null; record.error = null;
  record.featureBranch = null; record.reviewNote = null; record.taskNote = null;
  delete record.featureCommit; delete record.outputDigest; delete record.reviewMarkdown; delete record.publishedReview;
  delete record.task; delete record.diagnostic;
  record.progress = 'Review feedback was confirmed on the shared branch. Rework continues with the same Feature Request and frozen execution authority.';
  await save();
  return true;
}

export function validateSharedReviewReworks(record: SharedFeatureRecord) {
  if (record.reviewReworks === undefined) return;
  if (!Array.isArray(record.reviewReworks) || record.reviewReworks.length > 16 || new Set(record.reviewReworks.map(item => item.command.operationId)).size !== record.reviewReworks.length || record.reviewReworks.filter(item => item.status !== 'dispatched').length > 1)
    throw Error('Invalid shared review feedback history.');
  for (const receipt of record.reviewReworks) {
    const command = receipt.command;
    if (!['pending_source', 'pending_dispatch', 'dispatched'].includes(receipt.status) || receipt.digest !== gateDigest(command) ||
      command.action !== 'request_changes' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(command.operationId) ||
      !Number.isSafeInteger(command.inputRevision) || command.inputRevision! < 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(command.candidateCommit ?? '') ||
      !/^[a-f0-9]{64}$/.test(command.candidateDigest ?? '') || typeof command.note !== 'string' || !command.note.trim() || command.note.trim().length > 4000)
      throw Error('Invalid candidate-bound shared review feedback receipt.');
  }
}
