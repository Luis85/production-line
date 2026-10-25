import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultDeliveryProjectPolicy, deliveryPolicySnapshot, validateDeliveryProjectPolicy } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { remotePublicationView } from '../../src/worker/dist/worker/application/remote-delivery-view.js';
import { releaseView } from '../../src/worker/dist/worker/application/release-view.js';
import { tickAutomaticPublication } from '../../src/worker/dist/worker/status/workspace-automatic-publication.js';
import { publishRequest } from '../../src/worker/dist/worker/status/workspace-publication.js';
import { releaseRequest } from '../../src/worker/dist/worker/status/workspace-release.js';
import { fixture } from './request-gate-fixtures.mjs';
import { readyPublication, publicationCommand, target } from './remote-delivery-fixtures.mjs';

/** Keep the existing verified-candidate fixture while changing only the project's integration consent.
 * @param {import('../../src/worker/application/journal-ports.ts').RequestJournal} journal */
function markdownOnly(journal, remoteURL) {
  return new Proxy(journal, { get(value, key) {
    if (key !== 'ensure') { const member = value[key]; return typeof member === 'function' ? member.bind(value) : member; }
    return input => {
      const context = input.input.context, accepted = context.deliveryPolicy;
      const configuration = structuredClone(accepted.configuration); delete configuration.remoteDelivery; delete configuration.release;
      context.deliveryPolicy = deliveryPolicySnapshot(configuration, accepted.baseline);
      context.remoteURL = remoteURL;
      return value.ensure(input);
    };
  } });
}
function workspace(journal, unexpected) {
  return /** @type {import('../../src/worker/status/workspace-context.ts').WorkspaceContext} */ (/** @type {unknown} */ ({
    acceptingTasks: true, nativeWorkState: 'ready', sessions: { requests: journal },
    board: { verifyDelivery: unexpected, executionDetail: unexpected },
  }));
}

test('default and validated project policies retain Markdown delivery without a GitHub integration', () => {
  const configuration = validateDeliveryProjectPolicy(defaultDeliveryProjectPolicy());
  const snapshot = deliveryPolicySnapshot(configuration, '1'.repeat(40));
  for (const value of [configuration, snapshot.configuration]) {
    assert.equal(Object.hasOwn(value, 'remoteDelivery'), false);
    assert.equal(Object.hasOwn(value, 'release'), false);
  }
  const enabled = validateDeliveryProjectPolicy({ ...configuration, remoteDelivery: { ...target, automatic: true } });
  assert.equal(enabled.remoteDelivery.pullRequest, true); assert.equal(enabled.remoteDelivery.automatic, true);
  assert.equal(configuration.remoteDelivery, undefined, 'configuring GitHub must not mutate the plain Git policy');
});

test('a Git remote URL does not enable GitHub or manufacture publication evidence', async t => {
  for (const remote of ['ssh://git@git.example.test/team/project.git', 'https://github.com/example/project.git']) {
    const { journal } = await fixture(t), request = readyPublication(markdownOnly(journal, remote));
    const publication = remotePublicationView(request, true, null), release = releaseView(request, true);
    assert.equal(request.delivery.review.publication, 'local_only');
    assert.equal(publication.configured, false); assert.equal(publication.authorized, false);
    assert.equal(publication.canPush, false); assert.equal(publication.canCreatePullRequest, false); assert.equal(publication.canReconcile, false);
    assert.equal(release.configured, false); assert.equal(release.authorized, false);
    assert.equal(release.canMerge, false); assert.equal(release.canBuild, false); assert.equal(release.canPublish, false);
    assert.deepEqual(publication.publications, []); assert.deepEqual(release.state.operations, []);
  }
});

test('plain Git rejects explicit hosting commands before verification, authorization or any adapter call', async t => {
  const { journal } = await fixture(t), request = readyPublication(markdownOnly(journal, 'ssh://git@git.example.test/team/project.git'));
  let calls = 0;
  const unexpected = async () => { calls++; throw Error('A plain Git request cannot invoke a hosting adapter.'); };
  const host = workspace(journal, unexpected), before = journal.get(request.id), events = journal.events(request.id).events;
  const publication = /** @type {NonNullable<Parameters<typeof publishRequest>[2]>} */ (/** @type {unknown} */ ({
    authority: { authorize: unexpected }, port: { verify: unexpected, remoteHead: unexpected, push: unexpected, pullRequest: unexpected, createPullRequest: unexpected },
  }));
  for (const action of /** @type {const} */ (['push_candidate', 'create_pull_request'])) {
    const command = publicationCommand(request, action, 'disabled-' + action);
    assert.throws(() => journal.command(command), { code: 'conflict' });
    await assert.rejects(publishRequest(host, command, publication), { code: 'conflict' });
  }
  const release = /** @type {NonNullable<Parameters<typeof releaseRequest>[2]>} */ (/** @type {unknown} */ ({
    authority: { authorize: unexpected }, port: { pullRequest: unexpected, merge: unexpected, inspectBuild: unexpected, build: unexpected, inspectRelease: unexpected, publish: unexpected },
  }));
  for (const action of ['merge_candidate', 'build_release', 'publish_release']) {
    const candidate = request.delivery.review.candidate;
    const command = /** @type {import('../../src/worker/application/request-gates.ts').RequestCommand} */ ({
      action, requestId: request.id, expectedRevision: request.revision, operationId: 'disabled-' + action,
      deliveryRunId: candidate.runId, inputRevision: candidate.inputRevision, candidateCommit: candidate.candidateCommit, candidateDigest: candidate.candidateDigest,
      ...(action === 'publish_release' ? { releaseTag: 'v1.0.0' } : {}),
    });
    assert.throws(() => journal.command(command), { code: 'conflict' });
    await assert.rejects(releaseRequest(host, command, release), { code: 'conflict' });
  }
  assert.equal(calls, 0); assert.deepEqual(journal.get(request.id), before); assert.deepEqual(journal.events(request.id).events, events);
});

test('automatic polling leaves a plain Git request on its Markdown handoff without inspecting GitHub', async t => {
  const { journal } = await fixture(t), request = readyPublication(markdownOnly(journal, 'https://github.com/example/project.git'));
  let calls = 0;
  const unexpected = async () => { calls++; throw Error('GitHub was not enabled.'); };
  await tickAutomaticPublication(workspace(journal, unexpected), { now: () => 10000, view: unexpected, publish: unexpected });
  assert.equal(calls, 0); assert.deepEqual(journal.get(request.id).delivery.publications, undefined);
});
