import { releaseAccepted, releaseSubject } from '../../../application/release-view.js';
import { releasePending, type ReleaseArtifact, type ReleaseOperation, type ReleaseUpdate } from '../../../application/release-contracts.js';
import { releaseTag } from '../../../application/release-policy.js';
import { gateDigest, type RequestCommand, type WorkerRequest } from '../../../application/request-gates.js';
import type { RequestStore } from './store.js';
import { clone, conflict, identifier, invalid, iso } from './values.js';

export function requestReleaseCommand(store: RequestStore, request: WorkerRequest, input: RequestCommand) {
  const run = request.delivery, candidate = run?.review?.candidate;
  if (!run || !candidate || input.deliveryRunId !== run.id || input.inputRevision !== request.inputRevision || input.candidateCommit !== candidate.candidateCommit || input.candidateDigest !== candidate.candidateDigest)
    conflict('Release commands must identify the exact current delivery run, request revision and candidate.');
  const subject = releaseSubject(request), state = run.release ??= { operations: [] };
  if (input.action === 'reconcile_release' || input.action === 'confirm_release_stopped') {
    identifier(input.releaseOperationId, 'release operation ID');
    const previous = state.operations.find(item => item.operationId === input.releaseOperationId);
    if (!previous || !['pending', 'unknown'].includes(previous.status)) conflict('Only a saved unresolved release operation can be reconciled.');
    if (gateDigest(previous.candidate) !== gateDigest(candidate)) conflict('The saved release operation belongs to another candidate.');
    if (input.action === 'confirm_release_stopped') {
      if (previous.action !== 'build' || previous.status !== 'unknown' || !input.note?.trim()) conflict('Confirm stopped requires an unknown build and an operator inspection note.');
      previous.status = 'failed'; previous.detail = 'Operator attested the interrupted build process was inspected and stopped: ' + input.note.trim(); previous.updatedAt = iso();
      store.save(request, 'release_build_stop_attested'); return;
    }
    previous.status = 'pending'; previous.detail = 'Read-only reconciliation requested for the saved release operation.'; previous.updatedAt = iso();
    store.save(request, 'release_reconciliation_requested'); return;
  }
  if (!releaseAccepted(request) || releasePending(state)) conflict('Release requires human acceptance of the current verified candidate and no unresolved release operation.');
  if (state.published) conflict('This request already has a confirmed published release.');
  if (state.operations.length >= 32) conflict('This delivery reached its bounded release operation history.');
  const action = input.action === 'merge_candidate' ? 'merge' : input.action === 'build_release' ? 'build' : 'publish';
  if (action === 'merge' && state.merge) conflict('The accepted candidate is already merged. Continue its build and publication.');
  if (action !== 'merge' && !state.merge) conflict('Confirm the actual merged commit before building or publishing.');
  if (action === 'build' && state.build) conflict('The merged commit already has a successful retained build.');
  if (action === 'publish' && !state.build) conflict('Publication requires the successful exact merged-commit build.');
  const tag = action === 'publish' ? releaseTag(input.releaseTag, subject.target.tagPrefix) : undefined;
  if (tag && state.operations.some(item => item.action === 'publish' && item.tag !== tag && (item.status !== 'failed' || !item.retagEvidence))) conflict('Keep the same release tag when retrying this retained build publication.');
  const at = iso();
  const operation: ReleaseOperation = { operationId: input.operationId, action, status: 'pending', candidate: clone(candidate), target: clone(subject.target), repositoryId: subject.repositoryId,
    configurationDigest: subject.snapshot.configurationDigest, pullRequest: clone(subject.pullRequest), createdAt: at, updatedAt: at, detail: 'The release operation intent is retained before execution.',
    ...(state.merge ? { mergeCommit: state.merge.mergeCommit } : {}), ...(action === 'publish' ? { build: clone(state.build!), tag: tag! } : {}) };
  state.operations.push(operation); store.save(request, 'release_' + action + '_requested');
}
function artifacts(value: ReleaseArtifact[]) {
  if (!Array.isArray(value) || !value.length || value.length > 34 || value.some(item => !item || typeof item.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(item.name) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 67108864 || !/^[a-f0-9]{64}$/.test(item.sha256)) || new Set(value.map(item => item.name.toLowerCase())).size !== value.length)
    invalid('Release artifacts require bounded unique names, sizes and SHA-256 digests.');
}
export function requestReleaseResult(store: RequestStore, request: WorkerRequest, update: ReleaseUpdate) {
  const run = request.delivery, state = run?.release, operation = state?.operations.find(item => item.operationId === update.operationId), result = update.result;
  if (!run || run.id !== update.deliveryRunId || !state || !operation) conflict('The saved release operation no longer matches this result.');
  if (!['pending', 'unknown'].includes(operation.status)) {
    if (gateDigest({ status: operation.status, detail: operation.detail, ...(operation.merge ? { merge: operation.merge } : {}), ...(operation.built ? { built: operation.built } : {}), ...(operation.published ? { published: operation.published } : {}), ...(operation.retagEvidence ? { retagEvidence: operation.retagEvidence } : {}) }) === gateDigest(result)) return request;
    conflict('A settled release operation result is immutable.');
  }
  if (!['unknown', 'confirmed', 'not_observed', 'failed'].includes(result.status) || typeof result.detail !== 'string' || !result.detail.trim() || result.detail.length > 4000) invalid('Release results need a bounded state and explanation.');
  if (result.retagEvidence !== undefined) {
    const evidence = result.retagEvidence;
    if (operation.action !== 'publish' || result.status !== 'failed' || evidence.kind !== 'preflight_tag_conflict' || evidence.tag !== operation.tag || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(evidence.refObject) || !['commit', 'tag'].includes(evidence.objectType) || !['absent', 'foreign'].includes(evidence.release) || evidence.objectType === 'commit' && evidence.refObject === operation.mergeCommit) invalid('Retag evidence requires an exact conflicting Git object and no owned release observed before publication.');
  }
  if (result.status === 'confirmed') {
    if (operation.action === 'merge') {
      const merge = result.merge;
      if (!merge || result.built || result.published || merge.pullRequest !== operation.pullRequest.number || merge.headCommit !== operation.candidate.candidateCommit || merge.url !== operation.pullRequest.url || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(merge.mergeCommit) || !Number.isFinite(Date.parse(merge.mergedAt))) conflict('Merge evidence must establish the accepted head and actual merged commit.');
      state.merge = clone(merge);
    } else if (operation.action === 'build') {
      const built = result.built;
      if (!built || result.merge || result.published || built.operationId !== operation.operationId || built.commit !== operation.mergeCommit || !/^[a-f0-9]{64}$/.test(built.manifestDigest) || !Number.isFinite(Date.parse(built.builtAt))) conflict('Build evidence must identify its exact merged commit, operation and manifest.');
      artifacts(built.artifacts);
      const expectedNames = [...operation.target.build.artifacts.map(path => path.split('/').at(-1)!), 'werk-release-manifest.json', 'SHA256SUMS'];
      if (built.artifacts.length !== expectedNames.length || built.artifacts.some(item => !expectedNames.includes(item.name)) || built.artifacts.find(item => item.name === 'werk-release-manifest.json')?.sha256 !== built.manifestDigest) conflict('Build artifacts must include exactly the configured outputs and matching release manifest and checksums.');
      state.build = clone(built);
    } else {
      const published = result.published;
      if (!published || result.merge || result.built || published.tag !== operation.tag || published.commit !== operation.mergeCommit || published.url !== 'https://github.com/' + operation.target.repository + '/releases/tag/' + operation.tag || !Number.isFinite(Date.parse(published.publishedAt))) conflict('Publication must establish the exact release URL, tag and merged commit.');
      artifacts(published.assets);
      if (gateDigest([...published.assets].sort((a, b) => a.name.localeCompare(b.name))) !== gateDigest([...(operation.build?.artifacts ?? [])].sort((a, b) => a.name.localeCompare(b.name)))) conflict('Published assets must exactly match the successful retained build.');
      state.published = clone(published); request.phase = 'done';
    }
  } else if (result.merge || result.built || result.published) invalid('Unconfirmed release results cannot carry successful receipts.');
  Object.assign(operation, clone(result), { updatedAt: iso() }); store.save(request, 'release_' + operation.action + '_' + result.status); return request;
}
