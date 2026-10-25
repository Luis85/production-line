import test from 'node:test';
import assert from 'node:assert/strict';
import { tickAutomaticPublication } from '../../src/worker/dist/worker/status/workspace-automatic-publication.js';
import { remotePublicationView } from '../../src/worker/dist/worker/application/remote-delivery-view.js';
import { fixture } from './request-gate-fixtures.mjs';
import { readyPublication } from './remote-delivery-fixtures.mjs';

async function harness(t, automatic = true) {
  const { journal } = await fixture(t), request = readyPublication(journal, undefined, automatic), calls = [];
  const workspace = /** @type {import('../../src/worker/status/workspace-context.ts').WorkspaceContext} */ (/** @type {unknown} */ ({
    acceptingTasks: true, nativeWorkState: 'ready', sessions: { requests: journal },
  }));
  let clock = 10000, authorized = true, unknown = false;
  /** @type {NonNullable<Parameters<typeof tickAutomaticPublication>[1]>} */
  const ports = {
    now: () => clock,
    view: async (_workspace, id) => remotePublicationView(journal.get(id), authorized, authorized ? null : 'Policy approval is missing.'),
    publish: async (_workspace, command) => {
      calls.push(command.action);
      const intent = journal.command(command), item = intent.request.delivery.publications.at(-1);
      const result = unknown ? { status: /** @type {const} */ ('unknown'), detail: 'Remote acknowledgement is unknown.' }
        : { status: /** @type {const} */ ('confirmed'), detail: 'Exact fixture remote observation.', observation: { branch: item.candidate.branch, commit: item.candidate.candidateCommit,
          ...(item.action === 'pull_request' ? { pullRequest: { number: 17, url: 'https://github.com/example/project/pull/17', state: /** @type {const} */ ('open') } } : {}) } };
      return { request: journal.deliveryUpdate(command.requestId, { action: 'publication_result', deliveryRunId: item.candidate.runId, operationId: item.operationId, result }), duplicate: false };
    },
  };
  return { workspace, journal, request, calls, ports, advance() { clock += 2000; }, revoke() { authorized = false; }, unknown() { unknown = true; } };
}
test('approved automatic publication pushes once then creates one PR for the same exact candidate', async t => {
  const h = await harness(t);
  await tickAutomaticPublication(h.workspace, h.ports);
  assert.deepEqual(h.calls, ['push_candidate', 'create_pull_request']);
  const state = h.journal.get(h.request.id);
  assert.equal(state.delivery.publications.length, 2); assert.equal(state.attestation, null);
  assert.equal(state.delivery.publications[1].candidate.candidateCommit, state.delivery.review.candidate.candidateCommit);
  h.advance(); await tickAutomaticPublication(h.workspace, h.ports); assert.equal(h.calls.length, 2);
});
test('missing policy opt-in, revoked approval, held candidate and shutdown prevent automatic remote work', async t => {
  for (const setup of ['no-opt-in', 'revoked', 'held', 'stopping']) {
    const h = await harness(t, setup !== 'no-opt-in');
    if (setup === 'revoked') h.revoke();
    if (setup === 'held') h.journal.deliveryUpdate(h.request.id, { action: 'hold', code: 'source', reason: 'Canonical input changed.' });
    if (setup === 'stopping') h.workspace.acceptingTasks = false;
    await tickAutomaticPublication(h.workspace, h.ports); assert.equal(h.calls.length, 0, setup);
  }
});
test('unknown automatic push remains held for explicit reconciliation and never repeats or opens a PR', async t => {
  const h = await harness(t); h.unknown();
  await tickAutomaticPublication(h.workspace, h.ports); h.advance(); await tickAutomaticPublication(h.workspace, h.ports);
  assert.deepEqual(h.calls, ['push_candidate']);
  assert.equal(h.journal.get(h.request.id).delivery.publications[0].status, 'unknown');
});
