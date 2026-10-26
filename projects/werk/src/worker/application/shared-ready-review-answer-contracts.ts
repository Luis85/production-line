import type { SharedIntakeView, SharedReadyReviewAnswerSubject } from './shared-intake-contract.js';
export type { SharedReadyReviewAnswerSubject } from './shared-intake-contract.js';
export interface SharedReadyReviewAnswerCommand extends SharedReadyReviewAnswerSubject {
  action: 'answer_ready_review';
  projectId?: string;
  requestId: string;
  operationId: string;
  answer: string;
}
export interface SharedReadyReviewAnswerAcknowledgement {
  requestId: string;
  operationId: string;
  status: 'published';
}
export type SharedReadyReviewAnswerResult = SharedIntakeView & { readyReviewAnswer: SharedReadyReviewAnswerAcknowledgement };
export interface SharedReadyReviewAnswerReceipt {
  operationId: string;
  digest: string;
  subject: SharedReadyReviewAnswerSubject;
  writeOperationId: string;
  writeDigest: string;
  status: 'pending' | 'published' | 'rejected';
  publishedRevision?: string;
}
