import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerRequestJournal } from '../../src/worker/dist/worker/infrastructure/journal/requests.js';
import { remotePublicationView } from '../../src/worker/dist/worker/application/remote-delivery-view.js';
import { parseFeature, featureInput, featureRequestContext, renderFeature } from '../../src/worker/dist/worker/infrastructure/features/document.js';
import { markdownCommands } from '../../src/worker/dist/worker/infrastructure/features/markdown-contract.js';
import { featureInputHash } from '../../src/worker/dist/worker/application/feature-markdown.js';
import { fixture } from './request-gate-fixtures.mjs';
import { cleanup } from './fixture-cleanup.mjs';
import { readyPublication, publicationCommand } from './remote-delivery-fixtures.mjs';

/** @param {import('../../src/worker/application/journal-ports.ts').RequestJournal} journal
 * @param {import('../../src/worker/application/request-gates.ts').WorkerRequest} request @param {string} operationId
 * @param {import('../../src/worker/application/remote-delivery-contracts.ts').RemotePublicationResult} result */
function observe(journal, request, operationId, result) {
  return journal.deliveryUpdate(request.id, { action: 'publication_result', deliveryRunId: request.delivery.id, operationId, result });
}
const exactObservation = request => ({ branch: request.delivery.review.candidate.branch, commit: request.delivery.review.candidate.candidateCommit });

test('candidate-bound intents persist before publication and command replay cannot create a second intent', async t => {
  const { journal } = await fixture(t), initial = readyPublication(journal), command = publicationCommand(initial, 'push_candidate', 'push-once');
  assert.equal(remotePublicationView(initial, true, null).canPush, true);
  for (const change of [{ candidateCommit: 'f'.repeat(40) }, { inputRevision: 2 }, { deliveryRunId: 'stale-run' }, { candidateDigest: 'f'.repeat(64) }]) assert.throws(() => journal.command({ ...command, ...change }), /exact current/);
  const intent = journal.command(command).request;
  assert.equal(intent.delivery.publications.length, 1); assert.equal(intent.delivery.publications[0].status, 'pending');
  assert.equal(intent.attestation, null); assert.equal(intent.phase, 'review');
  const events = journal.events(initial.id).events;
  assert.equal(journal.command(command).duplicate, true); assert.deepEqual(journal.events(initial.id).events, events);
  assert.throws(() => journal.command({ ...command, candidateCommit: 'f'.repeat(40) }), /different input/);
  assert.equal(remotePublicationView(intent, true, null).canPush, false); assert.equal(remotePublicationView(intent, true, null).canReconcile, true);
  assert.equal(remotePublicationView(intent, false, 'Approval revoked.').canReconcile, false);
});

test('restart retains unknown publication and exact identity, blocks material change, then settles a read-only reconciliation', async t => {
  const { journal, directory } = await fixture(t), initial = readyPublication(journal);
  const intended = journal.command(publicationCommand(initial, 'push_candidate', 'push-lost')).request;
  journal.close(); const recovered = new WorkerRequestJournal(directory); await recovered.init(); cleanup(t, () => recovered.close());
  const unknown = recovered.get(initial.id);
  assert.equal(unknown.delivery.publications[0].status, 'unknown'); assert.equal(unknown.delivery.publications[0].operationId, 'push-lost');
  assert.deepEqual(unknown.delivery.publications[0].candidate, intended.delivery.review.candidate);
  assert.throws(() => recovered.command(publicationCommand(unknown, 'push_candidate', 'retry-unknown')), /Reconcile/);
  assert.throws(() => recovered.command({ action: 'propose', requestId: unknown.id, expectedRevision: unknown.revision, operationId: 'change-input', input: { ...unknown.input, message: 'Changed scope.' } }), /Reconcile/);
  const checking = recovered.command({ ...publicationCommand(unknown, 'reconcile_publication', 'observe-lost'), publicationOperationId: 'push-lost' }).request;
  const confirmed = observe(recovered, checking, 'push-lost', { status: 'confirmed', detail: 'Observed exact remote commit.', observation: exactObservation(checking) });
  assert.equal(confirmed.delivery.publications.length, 1); assert.equal(confirmed.delivery.publications[0].status, 'confirmed');
  assert.equal(confirmed.attestation, null); assert.equal(confirmed.phase, 'review');
  assert.equal(remotePublicationView(confirmed, true, null).canCreatePullRequest, true);
  const events = recovered.events(initial.id).events;
  observe(recovered, confirmed, 'push-lost', { status: 'confirmed', detail: 'Repeated observed commit.', observation: exactObservation(confirmed) });
  assert.deepEqual(recovered.events(initial.id).events, events);
  assert.throws(() => observe(recovered, confirmed, 'push-lost', { status: 'failed', detail: 'Rewrite settled evidence.' }), /immutable/);
});

test('PR creation is separate from push and exact confirmed PR observations never accept the request', async t => {
  const { journal } = await fixture(t), initial = readyPublication(journal);
  assert.throws(() => journal.command(publicationCommand(initial, 'create_pull_request', 'premature-pr')), /Publish and confirm/);
  let current = journal.command(publicationCommand(initial, 'push_candidate', 'push')).request;
  current = observe(journal, current, 'push', { status: 'confirmed', detail: 'Candidate pushed.', observation: exactObservation(current) });
  current = journal.command(publicationCommand(current, 'create_pull_request', 'pr')).request;
  const observation = { ...exactObservation(current), pullRequest: { number: 17, url: 'https://github.com/example/project/pull/17', state: /** @type {const} */ ('open') } };
  for (const invalid of [{ ...observation, commit: 'f'.repeat(40) }, { ...observation, pullRequest: { ...observation.pullRequest, url: 'https://other.invalid/17' } }]) {
    assert.throws(() => observe(journal, current, 'pr', { status: 'confirmed', detail: 'Invalid claim.', observation: invalid }), /exact/);
  }
  current = observe(journal, current, 'pr', { status: 'confirmed', detail: 'GitHub PR observed.', observation });
  assert.equal(current.phase, 'review'); assert.equal(current.attestation, null); assert.equal(current.delivery.review.publication, 'local_only');
  assert.equal(remotePublicationView(current, true, null).canCreatePullRequest, false);
  assert.throws(() => journal.command(publicationCommand(current, 'create_pull_request', 'duplicate-pr')), /already has a confirmed/);
});

test('cancellation stays pending until a saved unknown remote outcome is reconciled', async t => {
  const { journal } = await fixture(t), initial = readyPublication(journal);
  const pending = journal.command(publicationCommand(initial, 'push_candidate', 'cancelled-push')).request;
  const cancelling = journal.command({ action: 'cancel', requestId: initial.id, expectedRevision: pending.revision, operationId: 'cancel-request', deliveryRunId: initial.delivery.id, inputRevision: 1 }).request;
  assert.notEqual(cancelling.lifecycle, 'cancelled');
  const unknown = observe(journal, cancelling, 'cancelled-push', { status: 'unknown', detail: 'Connection interrupted after possible push.' });
  assert.notEqual(unknown.lifecycle, 'cancelled');
  const checking = journal.command({ ...publicationCommand(unknown, 'reconcile_publication', 'check-cancelled-push'), publicationOperationId: 'cancelled-push' }).request;
  const cancelled = observe(journal, checking, 'cancelled-push', { status: 'confirmed', detail: 'Push occurred before cancellation.', observation: exactObservation(checking) });
  assert.equal(cancelled.lifecycle, 'cancelled'); assert.equal(cancelled.delivery.publications[0].status, 'confirmed'); assert.equal(cancelled.attestation, null);
});

test('Markdown publication commands preserve semantic input and render only observed remote receipts', () => {
  const raw = '---\nschema: worker.request/v1\nid: FR-1\ntitle: Publish candidate\nintent: submit\npaths: [src/]\n---\n## Outcome\n\nImplement the bounded change.\n';
  const frontmatter = `publication:\n  command_id: publish-one\n  action: push_candidate\n  run_id: run-one\n  request_revision: 1\n  candidate_commit: ${'a'.repeat(40)}\n`;
  const parsed = parseFeature(raw.replace('paths: [src/]\n', 'paths: [src/]\n' + frontmatter));
  const input = featureInput(parsed, 'claude-cli'), original = featureInput(parseFeature(raw), 'claude-cli');
  assert.equal(featureInputHash(input), featureInputHash(original));
  assert.deepEqual(featureRequestContext(parsed.data, input), featureRequestContext(parseFeature(raw).data, original));
  assert.deepEqual(markdownCommands(parsed), [{ commandId: 'publish-one', action: 'push_candidate', runId: 'run-one', requestRevision: 1, candidateCommit: 'a'.repeat(40) }]);
  const reconcile = parsed.raw.replace('action: push_candidate', 'action: reconcile_publication\n  operation_id: earlier-push');
  assert.equal(markdownCommands(parseFeature(reconcile))[0].publicationOperationId, 'earlier-push');
  for (const line of ['  command_id: publish-one\n', '  run_id: run-one\n', '  request_revision: 1\n', `  candidate_commit: ${'a'.repeat(40)}\n`]) assert.throws(() => markdownCommands(parseFeature(parsed.raw.replace(line, ''))));
  assert.throws(() => markdownCommands(parseFeature(reconcile.replace('  operation_id: earlier-push\n', ''))), /operation_id/);
  const rendered = renderFeature(parsed, 'FR-1', 'review', {}); assert.match(rendered, /publication:/); assert.doesNotMatch(rendered, /GitHub pull request:/);
});
