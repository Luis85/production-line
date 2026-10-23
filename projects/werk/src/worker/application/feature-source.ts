import { featureCommandDigest, featureInputHash, acceptedFeatureHash, type FeatureSourceIssue } from './feature-markdown.js';
import type { FeatureRecord, FeatureFile, FeatureQueuePort } from './feature-requests.js';
import type { RequestCommand } from './request-gates.js';

export async function reconcileFeatureSource(record: FeatureRecord, file: FeatureFile | undefined, issue: FeatureSourceIssue | undefined, queue: FeatureQueuePort, persist: () => Promise<void>, stable: boolean) {
  const changed = file?.input && featureInputHash(file.input) !== acceptedFeatureHash(record);
  if (changed) { record.pendingInput = structuredClone(file.input!); record.pendingInputHash = featureInputHash(file.input!); }
  else if (file?.input) { delete record.pendingInput; delete record.pendingInputHash; }
  const sourceIssue = issue ?? (changed ? { code: 'changed_input' as const, reason: 'The request changed. Reconcile the current attempt before reassessing this revision.' } : undefined);
  record.sourceIssue = sourceIssue;
  if (file) record.sourceRevision = file.revision;
  await persist();
  if (queue.source) await queue.source(record, sourceIssue ?? null);
  if (issue || !file) return;
  if (stable && !changed && record.input && file.input && record.input.priority !== file.input.priority) {
    const updated = !record.submitted && !queue.inspect(record) || await queue.reprioritize?.(record, file.input.priority);
    if (updated) { record.input.priority = file.input.priority; await persist(); }
  }
  if (stable) await consumeCommands(record, file, queue, persist);
  const request = queue.inspect(record)?.request;
  const terminal = request ? ['done', 'cancelled'].includes(request.phase) : ['completed', 'cancelled'].includes(record.status);
  if (stable && changed && !terminal && queue.revise && await queue.revise(record, file.input!, record.pendingInputHash!)) {
    record.input = structuredClone(file.input!); record.inputHash = record.pendingInputHash!;
    record.semanticRevision = (record.semanticRevision ?? 1) + 1;
    delete record.pendingInput; delete record.pendingInputHash; delete record.sourceIssue;
    await persist(); await queue.source?.(record, null);
  }
}
async function consumeCommands(record: FeatureRecord, file: FeatureFile, queue: FeatureQueuePort, persist: () => Promise<void>) {
  for (const value of file.commands ?? []) {
    const digest = featureCommandDigest(value);
    record.commandReceipts ??= [];
    let receipt = record.commandReceipts.find(item => item.commandId === value.commandId);
    if (receipt && receipt.digest !== digest) throw Error(`Command ${value.commandId} was already reserved with different content. Use a new command_id.`);
    if (receipt?.outcome) continue;
    if (!queue.request) throw Error('Request controls are unavailable. The command remains unconsumed.');
    if (!receipt) {
      if (record.commandReceipts.length >= 1000) throw Error('This request reached its 1,000-command history limit. Retain its history before archiving.');
      const request = queue.inspect(record)?.request;
      if (!request) throw Error('Request history is unavailable; the command cannot be safely consumed.');
      if (value.requestRevision !== undefined && value.requestRevision !== request.inputRevision) throw Error('Command targets a stale request revision. Inspect the current review and use a new command_id.');
      const candidate = value.action === 'criterion_decision' ? request.delivery?.review?.candidate ?? request.delivery?.checkpoints?.at(-1) : request.delivery?.review?.candidate;
      if (value.action === 'criterion_decision' && value.candidateCommit && candidate?.candidateCommit !== value.candidateCommit) throw Error('Command targets a different candidate commit. Inspect the current candidate and use a new command_id.');
      const command: RequestCommand = {
        action: value.action === 'accept' ? 'attest' : value.action,
        requestId: request.id, expectedRevision: request.revision, operationId: value.commandId,
        inputRevision: value.requestRevision ?? request.inputRevision,
        ...(value.publicationOperationId ? { publicationOperationId: value.publicationOperationId } : {}),
        ...(value.runId ? { deliveryRunId: value.runId } : value.action === 'reopen' && request.delivery ? { deliveryRunId: request.delivery.id } : {}),
        ...(value.feedback ? { note: value.feedback } : value.action === 'accept' ? { note: 'Accepted through the canonical Feature Request.' } : {}),
        ...(value.candidateCommit ? { candidateCommit: value.candidateCommit, candidateDigest: candidate?.candidateDigest } : {}),
        ...(value.action === 'readiness_decision' ? { inputHash: value.inputHash, assessmentId: value.assessmentId, proposalId: value.proposalId, decision: value.decision } : {}),
        ...(value.criterionDecision ? { criterionDecision: value.criterionDecision } : {}),
        ...(value.reviewDurationMinutes !== undefined ? { reviewDurationMinutes: value.reviewDurationMinutes } : {}),
        ...(['accept', 'request_changes'].includes(value.action) && value.humanChecks ? { humanOutcomes: value.humanChecks.map(check => ({ criterionId: check.criterionId, outcome: check.outcome === 'pass' ? 'passed' as const : check.outcome === 'fail' ? 'failed' as const : 'exempted' as const, reason: check.note })) } : {}),
        ...(value.action === 'accept' ? { inputHash: request.inputHash, outputDigest: request.execution?.outputDigest ?? undefined,
          humanOutcomes: (value.humanChecks ?? []).map(check => ({ criterionId: check.criterionId, outcome: check.outcome === 'pass' ? 'passed' : check.outcome === 'fail' ? 'failed' : 'exempted', reason: check.note })) } : {}),
      };
      receipt = { commandId: value.commandId, digest, command }; record.commandReceipts.push(receipt); await persist();
    }
    const owner = queue.inspect(record)?.request;
    if (!owner || receipt.command.requestId !== owner.id || receipt.command.operationId !== value.commandId || receipt.command.action !== (value.action === 'accept' ? 'attest' : value.action)) throw Error('The saved command receipt does not belong to this request and action. Restore its retained history before replaying.');
    try { await queue.request(record, receipt.command); receipt.outcome = 'accepted'; receipt.message = 'Recorded by the worker.'; }
    catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'invalid_input' && code !== 'conflict') throw error;
      receipt.outcome = 'rejected'; receipt.message = error instanceof Error ? error.message.slice(0, 500) : 'Command rejected. Inspect the request and submit a new command ID.';
    }
    await persist();
  }
}
