import type { SharedReadyReviewAnswerCommand, SharedReadyReviewAnswerResult, SharedReadyReviewAnswerSubject } from '../application/shared-ready-review-answer-contracts';
export interface ReadyAnswerDraft { answer: string; subject: SharedReadyReviewAnswerSubject | null; confirmedReviewOperationId: string | null; pending: SharedReadyReviewAnswerCommand | null; busy: boolean; error: string; notice: string; }
export const emptyReadyAnswerDraft = (): ReadyAnswerDraft => ({ answer: '', subject: null, confirmedReviewOperationId: null, pending: null, busy: false, error: '', notice: '' });
interface Ports { draft: ReadyAnswerDraft; active(): boolean; epoch(): number; uuid(): string; send(command: SharedReadyReviewAnswerCommand): Promise<SharedReadyReviewAnswerResult>; }
export function sameReadyAnswerSubject(a: SharedReadyReviewAnswerSubject, b: SharedReadyReviewAnswerSubject): boolean {
  return a.expectedGeneration === b.expectedGeneration && a.expectedReviewOperationId === b.expectedReviewOperationId && a.expectedReviewDigest === b.expectedReviewDigest && a.expectedSourceCommit === b.expectedSourceCommit && a.expectedSourceRevision === b.expectedSourceRevision;
}
/** Retain one exact answer-only Git operation. Readiness and implementation remain worker decisions. */
export function createReadyAnswerController(ports: Ports) {
  const draft = ports.draft;
  return { async submit(projectId: string, requestId: string, subject?: SharedReadyReviewAnswerSubject) {
    if (!ports.active() || draft.busy) return false;
    if (!draft.pending) {
      if (!projectId || !subject || !draft.answer.trim() || draft.answer.trim().length > 8000) return false;
      if (draft.subject && !sameReadyAnswerSubject(draft.subject, subject)) return false;
      draft.subject = { ...subject };
      draft.pending = { action: 'answer_ready_review', projectId, requestId, operationId: ports.uuid(), ...subject, answer: draft.answer.trim() };
    }
    const command = JSON.parse(JSON.stringify(draft.pending)) as SharedReadyReviewAnswerCommand, epoch = ports.epoch();
    draft.busy = true; draft.error = ''; draft.notice = '';
    try {
      const result = await ports.send(command);
      if (!ports.active() || epoch !== ports.epoch()) return false;
      const receipt = result.readyReviewAnswer;
      if (result.config.repositoryId !== command.projectId || receipt?.requestId !== command.requestId || receipt.operationId !== command.operationId || receipt.status !== 'published') throw Error('The worker did not confirm this exact answer publication. Retry the saved answer.');
      draft.pending = null; draft.answer = ''; draft.subject = null; draft.confirmedReviewOperationId = command.expectedReviewOperationId; draft.notice = 'Answer committed and pushed. The next intake check will review the same Feature Request again; implementation has not been started by this action.';
      return true;
    } catch (failure) {
      if (!ports.active() || epoch !== ports.epoch()) return false;
      draft.error = (failure as Error).message;
      if ([400, 404, 409].includes((failure as { status?: number }).status ?? 0)) draft.pending = null;
      return false;
    } finally { if (epoch === ports.epoch()) draft.busy = false; }
  } };
}
