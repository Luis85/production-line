import { readyPublication, publicationCommand, publication } from './remote-delivery-fixtures.mjs';
import { deliveryPolicySnapshot } from '../../src/worker/dist/worker/application/delivery-policy.js';

/** @type {import('../../src/worker/application/release-policy.ts').ReleasePolicy} */
const releaseTarget = { repository: 'example/project', base: 'main', mergeMethod: 'squash', tagPrefix: 'v', prerelease: false,
  build: { executable: 'node', args: ['build.mjs'], timeoutMs: 30000, artifacts: ['out/app.zip'] } };
/** @param {'merge'|'build'|'publish'} [action] @returns {import('../../src/worker/application/release-contracts.ts').ReleaseOperation} */
export function releaseOperation(action = 'merge') {
  const previous = publication();
  return { operationId: 'release-one', action, status: 'pending', candidate: previous.candidate, target: structuredClone(releaseTarget), repositoryId: previous.repositoryId,
    configurationDigest: previous.configurationDigest, pullRequest: { number: 17, url: 'https://github.com/example/project/pull/17', branch: previous.candidate.branch },
    createdAt: previous.createdAt, updatedAt: previous.updatedAt, detail: 'Saved release intent.',
    ...(action === 'merge' ? {} : { mergeCommit: 'b'.repeat(40) }) };
}
/** @param {import('../../src/worker/application/release-contracts.ts').ReleaseOperation} operation */
export function buildReceipt(operation) {
  return { operationId: operation.operationId, commit: operation.mergeCommit, manifestDigest: 'a'.repeat(64), builtAt: '2026-10-25T00:00:00.000Z',
    artifacts: [{ name: 'app.zip', bytes: 3, sha256: 'b'.repeat(64) }, { name: 'werk-release-manifest.json', bytes: 100, sha256: 'a'.repeat(64) }, { name: 'SHA256SUMS', bytes: 200, sha256: 'c'.repeat(64) }] };
}
/** @param {import('../../src/worker/application/journal-ports.ts').RequestJournal} journal */
export function readyRelease(journal) {
  const proxy = new Proxy(journal, { get(target, key) {
    if (key !== 'ensure') { const value = target[key]; return typeof value === 'function' ? value.bind(target) : value; }
    return input => {
      const context = input.input.context, configuration = context.deliveryPolicy.configuration;
      configuration.release = structuredClone(releaseTarget);
      context.deliveryPolicy = deliveryPolicySnapshot(configuration, context.deliveryPolicy.baseline);
      return target.ensure(input);
    };
  } });
  let request = readyPublication(proxy);
  const observe = (operationId, result) => journal.deliveryUpdate(request.id, { action: 'publication_result', deliveryRunId: request.delivery.id, operationId, result });
  request = journal.command(publicationCommand(request, 'push_candidate', 'release-push')).request;
  const candidate = request.delivery.review.candidate, observation = { branch: candidate.branch, commit: candidate.candidateCommit };
  request = observe('release-push', { status: 'confirmed', detail: 'Push confirmed.', observation });
  request = journal.command(publicationCommand(request, 'create_pull_request', 'release-pr')).request;
  request = observe('release-pr', { status: 'confirmed', detail: 'PR confirmed.', observation: { ...observation, pullRequest: { number: 17, url: 'https://github.com/example/project/pull/17', state: 'open' } } });
  return request;
}
/** @param {import('../../src/worker/application/journal-ports.ts').RequestJournal} journal
 * @param {import('../../src/worker/application/request-gates.ts').WorkerRequest} request */
export function acceptRelease(journal, request) {
  return journal.command({ action: 'attest', operationId: 'human-acceptance', requestId: request.id, expectedRevision: request.revision, note: 'Inspected the exact candidate and its mandatory criterion.',
    inputRevision: request.inputRevision, inputHash: request.inputHash, outputDigest: request.execution.outputDigest,
    candidateCommit: request.delivery.review.candidate.candidateCommit, candidateDigest: request.delivery.review.candidate.candidateDigest,
    humanOutcomes: [{ criterionId: 'human:1:0123456789ab', outcome: 'passed', reason: 'Verified the visible value.' }] }).request;
}
/** @param {import('../../src/worker/application/request-gates.ts').WorkerRequest} request
 * @param {typeof import('../../src/worker/application/release-contracts.ts').releaseCommands[number]} action
 * @param {string} operationId @returns {import('../../src/worker/application/request-gates.ts').RequestCommand} */
export function releaseCommand(request, action, operationId) {
  const exact = request.delivery.review.candidate;
  return { action, operationId, requestId: request.id, expectedRevision: request.revision, deliveryRunId: exact.runId, inputRevision: exact.inputRevision,
    candidateCommit: exact.candidateCommit, candidateDigest: exact.candidateDigest };
}
