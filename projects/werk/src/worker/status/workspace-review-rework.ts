import { DomainError } from '../../shared/errors.js';
import { reviewReworkInput } from '../application/remote-delivery-rework.js';
import type { RequestCommand } from '../application/request-gates.js';
import { parseFeature } from '../infrastructure/features/document.js';
import type { SharedFeatureIntake } from '../application/shared-feature-intake.js';
import type { SharedFeatureRecord } from '../application/shared-feature-state.js';
import type { WorkspaceContext } from './workspace-context.js';

/** UI feedback updates the canonical source; the ordinary watcher owns its revision and execution. */
export async function continueReviewRework(workspace: WorkspaceContext, input: RequestCommand) {
  const gates = workspace.sessions.requests, request = gates.get(input.requestId);
  const revised = reviewReworkInput(request, input);
  if (!revised) return;
  const taskId = request.owner.taskId;
  const shared = taskId ? workspace.featureProjects.sharedForTask(taskId) : undefined;
  if (shared) { const intake: SharedFeatureIntake = shared.project.sharedRuntime.intake; await intake.reviewFeedback(taskId!, input); return; }
  const folder = workspace.featureProjects.forSession(request.owner.sessionId);
  if (folder) {
    const features = folder.project.features;
    if (!features || !folder.reference.sourcePath) throw new DomainError('conflict', 'Restore the canonical Feature Request before continuing review rework.');
    const file = await features.action({ action: 'get', name: folder.reference.sourcePath });
    if (!file.markdown || !file.revision) throw new DomainError('conflict', 'The canonical Feature Request is unavailable. Restore its current note.');
    const marker = `<!-- werk-review-feedback:${input.operationId} -->`;
    if (!file.markdown.includes(marker)) {
      const parsed = parseFeature(file.markdown);
      if (parsed.data.schema !== 'worker.request/v1') throw new DomainError('conflict', 'The review feedback is recorded. Legacy accepted notes require a successor versioned Feature Request for rework.');
      // Preserve all user text/frontmatter; generated worker text remains managed by the watcher.
      const markdown = file.markdown.trimEnd() + '\n\n## Review feedback\n\n' + input.note!.trim() + '\n' + marker + '\n';
      await features.action({ action: 'edit', name: file.name, revision: file.revision, markdown });
    }
    await features.tick(true);
    return;
  }
  // Non-file local tasks retain the request journal as their canonical input.
  gates.reviseInput(request.id, revised);
  const current = gates.get(request.id);
  if (gates.evaluate(current.id, 'ready').passed) {
    if (current.input.kind === 'patch') await workspace.board.executeRequest(current.id);
    else await workspace.sessions.executeRequest(current.id);
  }
}

/** Shared Git calls this only after its canonical feedback projection has a confirmed remote receipt. */
export async function dispatchSharedReviewRework(workspace: WorkspaceContext, record: SharedFeatureRecord, input: RequestCommand) {
  const gates = workspace.sessions.requests, request = gates.get(input.requestId);
  if (request.owner.taskId !== record.taskId) throw new DomainError('conflict', 'Shared feedback belongs to another worker task.');
  const revised = reviewReworkInput(request, input);
  if (revised) gates.reviseInput(request.id, revised);
  const current = gates.get(request.id);
  const previous = current.deliveryHistory?.findLast(run => run.review?.candidate.candidateCommit === input.candidateCommit && run.review?.candidate.candidateDigest === input.candidateDigest);
  if (!previous || current.execution?.inputRevision === current.inputRevision) return;
  if (!['readiness', 'ready'].includes(current.phase)) return;
  if (gates.evaluate(current.id, 'ready').passed) await workspace.board.executeRequest(current.id);
}
