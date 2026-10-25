import { featureWorkflowPath } from '../../../application/feature-workflow.js';
import { deliveryAccepted } from '../../../application/delivery-acceptance.js';
import { localMergeSubject } from '../../../application/local-merge-view.js';
import { localMergePending, type LocalMergeOperation, type LocalMergeUpdate } from '../../../application/local-merge-contracts.js';
import { gateDigest, type RequestCommand, type WorkerRequest } from '../../../application/request-gates.js';
import type { RequestStore } from './store.js';
import { clone, conflict, identifier, invalid, iso } from './values.js';
const oid = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const branch = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && value !== '@' && !value.startsWith('-') && !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{') && !value.endsWith('.') && value.split('/').every(part => !!part && !part.startsWith('.') && !part.endsWith('.lock'));

export function requestLocalMergeCommand(store: RequestStore, request: WorkerRequest, input: RequestCommand) {
  const { repositoryId, candidate } = localMergeSubject(request), run = request.delivery!;
  if (input.deliveryRunId !== run.id || input.inputRevision !== request.inputRevision || input.candidateCommit !== candidate.candidateCommit || input.candidateDigest !== candidate.candidateDigest) conflict('Main checkout merge must identify the exact current delivery run, revision and candidate.');
  const state = run.localMerge ??= { operations: [] };
  if (input.action === 'reconcile_local_merge') {
    identifier(input.localMergeOperationId, 'local merge operation ID');
    const operation = state.operations.find(value => value.operationId === input.localMergeOperationId);
    if (!operation || !['pending', 'unknown'].includes(operation.status) || gateDigest(operation.candidate) !== gateDigest(candidate)) conflict('Only the current candidate saved unresolved main checkout merge can be reconciled.');
    operation.status = 'pending'; operation.updatedAt = iso(); operation.detail = 'Read-only main checkout merge reconciliation was requested.';
    store.save(request, 'local_merge_reconciliation_requested'); return;
  }
  if (!deliveryAccepted(request) || localMergePending(state) || state.merged) conflict('Main checkout merge requires exact human acceptance, no unresolved merge, and an unmerged candidate.');
  if (state.operations.length >= 32) conflict('This delivery reached its bounded main checkout merge history.');
  if (!branch(input.mainBranch) || !oid(input.mainHead) || typeof input.mainCheckout !== 'string' || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(input.mainCheckout) || input.mainCheckout.length > 4096 || /[\x00-\x1f\x7f]/.test(input.mainCheckout)) invalid('Main checkout approval requires its exact absolute path, branch and full expected head.');
  const at = iso(), operation: LocalMergeOperation = { operationId: input.operationId, status: 'pending', repositoryId, checkoutPath: input.mainCheckout, mainBranch: input.mainBranch, mainHead: input.mainHead, candidate: clone(candidate), createdAt: at, updatedAt: at, detail: 'Explicit main checkout merge approval retained before any Git mutation.' };
  state.operations.push(operation); store.save(request, 'local_merge_requested');
}
export function requestLocalMergeUpdate(store: RequestStore, request: WorkerRequest, update: LocalMergeUpdate) {
  const run = request.delivery, state = run?.localMerge, operation = state?.operations.find(value => value.operationId === update.operationId);
  if (!run || run.id !== update.deliveryRunId || !state || !operation) conflict('The retained main checkout merge identity changed before its result was recorded.');
  if (update.action === 'local_merge_prepared') {
    if (!['pending', 'unknown'].includes(operation.status) || !oid(update.preparation.mergeCommit) || !oid(update.preparation.tree)) conflict('Only a saved unresolved merge can retain an exact prepared commit and tree.');
    if (update.preparation.metadataPaths !== undefined && (!Array.isArray(update.preparation.metadataPaths) || update.preparation.metadataPaths.length > 512 || update.preparation.metadataPaths.some(path => featureWorkflowPath(path) !== path))) invalid('Prepared merge metadata paths must be a bounded list of safe workflow files.');
    if (operation.preparation && gateDigest(operation.preparation) !== gateDigest(update.preparation)) conflict('A retained prepared merge commit is immutable.');
    operation.preparation = clone(update.preparation); operation.updatedAt = iso(); store.save(request, 'local_merge_prepared'); return request;
  }
  const { result } = update;
  if (!['pending', 'unknown'].includes(operation.status)) {
    if (gateDigest({ status: operation.status, detail: operation.detail, ...(operation.receipt ? { receipt: operation.receipt } : {}) }) === gateDigest(result)) return request;
    conflict('A settled main checkout merge receipt is immutable.');
  }
  if (!['confirmed', 'unknown', 'not_observed', 'failed'].includes(result.status) || typeof result.detail !== 'string' || !result.detail.trim() || result.detail.length > 4000) invalid('Main checkout merge outcomes require a bounded state and explanation.');
  if (result.status === 'confirmed') {
    const receipt = result.receipt, prepared = operation.preparation;
    if (!receipt || !prepared || receipt.branch !== operation.mainBranch || receipt.previousHead !== operation.mainHead || receipt.candidateCommit !== operation.candidate.candidateCommit || receipt.mergeCommit !== prepared.mergeCommit || receipt.tree !== prepared.tree || !Number.isFinite(Date.parse(receipt.mergedAt))) conflict('Main checkout merge confirmation must identify the retained prepared commit, tree and exact approved destination.');
    state.merged = clone(receipt);
  } else if (result.receipt) invalid('An unconfirmed main checkout merge cannot contain a successful receipt.');
  Object.assign(operation, clone(result), { updatedAt: iso() }); store.save(request, 'local_merge_' + result.status); return request;
}
