import { createHash } from 'node:crypto';
import { acceptedRequest } from './workflow-fixture.mjs';
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
/** Independent canonical policy: the mutation target does not create its own authority. */
/** @param {boolean|'absent'} [flag] @param {boolean} [release] */
export function localRequest(flag = true, release = false) {
  const request = acceptedRequest();
  const configuration = { schemaVersion: 1, version: 1, defaultProfile: 'feature', ...(flag === 'absent' ? {} : { localMerge: flag }), reviewDirectory: 'feature-reviews', profiles: [
    { id: 'feature', minimumCriteria: 1, minimumMessageLength: 20, maxRepairAttempts: 2, verificationInputs: ['.werk/delivery-policy.json'] },
    { id: 'lightweight', minimumCriteria: 0, minimumMessageLength: 1, maxRepairAttempts: 1, verificationInputs: ['.werk/delivery-policy.json'] },
  ] };
  if (release) Object.assign(configuration, { remoteDelivery: { remote: 'origin', repository: 'example/project', base: 'main', push: true, pullRequest: true, draft: false }, release: { repository: 'example/project', base: 'main', mergeMethod: 'squash', tagPrefix: 'v', prerelease: false, build: { executable: 'node', args: ['build.mjs'], timeoutMs: 30000, artifacts: ['out/app.zip'] } } });
  request.input.context = { repositoryId: 'repo-one', deliveryPolicy: { schemaVersion: 1, baseline: request.delivery.review.candidate.baseline, configuration, configurationDigest: createHash('sha256').update(canonical(configuration)).digest('hex'), profile: structuredClone(configuration.profiles[0]) } };
  return request;
}
/** @param {ReturnType<typeof localRequest>} request */
export function localCommand(request, action = 'merge_local_candidate') {
  const candidate = request.delivery.review.candidate;
  return /** @type {import('../../../src/worker/application/request-gates.ts').RequestCommand} */ ({ action, requestId: request.id, expectedRevision: request.revision, operationId: 'local-one', deliveryRunId: request.delivery.id, inputRevision: request.inputRevision, candidateCommit: candidate.candidateCommit, candidateDigest: candidate.candidateDigest,
    ...(action === 'merge_local_candidate' ? { mainBranch: 'main', mainHead: '1'.repeat(40), mainCheckout: '/assigned/project' } : { localMergeOperationId: 'local-one' }) });
}
export const preparation = { mergeCommit: 'b'.repeat(40), tree: 'c'.repeat(40) };
