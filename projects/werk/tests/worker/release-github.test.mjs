import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createReleaseGitHub } from '../../src/worker/dist/worker/infrastructure/release-github.js';
import { ProcessRunError } from '../../src/worker/dist/shared/process/launcher.js';
import { cleanup } from './fixture-cleanup.mjs';

const abort = () => new AbortController().signal;
const digest = value => createHash('sha256').update(value).digest('hex');
const merged = 'e'.repeat(40);
const now = '2026-10-25T16:00:00Z';
function missing() { return new ProcessRunError('exit', { exitCode: 1, stdout: Buffer.from(JSON.stringify({ status: 404, message: 'Not Found' })), stderr: Buffer.alloc(0) }); }
/** @returns {import('../../src/worker/application/release-contracts.ts').ReleaseOperation & {build: import('../../src/worker/application/release-contracts.ts').ReleaseBuildReceipt; mergeCommit:string; tag:string}} */
function operation() {
  return { operationId: 'publish-1', action: /** @type {const} */ ('publish'), status: /** @type {const} */ ('pending'), candidate: { requestId: 'request-one', inputRevision: 1, inputHash: 'a'.repeat(64), runId: 'delivery-one', baseline: '1'.repeat(40), branch: 'werk/delivery/candidate-one', candidateCommit: '2'.repeat(40), tree: '3'.repeat(40), candidateDigest: '4'.repeat(64), patchDigest: '5'.repeat(64), policyDigest: '6'.repeat(64), checkDefinitionDigest: '7'.repeat(64), createdAt: now },
    target: { repository: 'example/project', base: 'main', mergeMethod: /** @type {const} */ ('squash'), tagPrefix: 'v', prerelease: false,
      build: { executable: 'node', args: ['build.mjs'], timeoutMs: 10000, artifacts: ['out/app.zip'] } },
    repositoryId: 'project', configurationDigest: 'a'.repeat(64), pullRequest: { number: 17, url: 'https://github.com/example/project/pull/17', branch: 'werk/delivery/candidate-one' },
    mergeCommit: merged, tag: 'v1.0.0', createdAt: now, updatedAt: now, detail: 'Publish intent',
    build: { operationId: 'build-1', commit: merged, artifacts: [], manifestDigest: 'b'.repeat(64), builtAt: now } };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-release-github-'));
  cleanup(t, () => rm(directory, { recursive: true, force: true }));
  const op = operation();
  for (const [name, bytes] of [['app.zip', 'verified artifact'], ['werk-release-manifest.json', '{}'], ['SHA256SUMS', 'fixture sums']]) {
    await writeFile(join(directory, name), bytes);
    op.build.artifacts.push({ name, bytes: Buffer.byteLength(bytes), sha256: digest(bytes) });
  }
  const calls = [];
  /** @type {Record<string, any>} */ const state = {
    tag: null, release: null, assets: [], uploads: 0,
    pr: { number: 17, node_id: 'PR_fixture17', draft: false, html_url: op.pullRequest.url, state: 'open', merged: false, merged_at: null, merge_commit_sha: null,
      head: { ref: op.pullRequest.branch, sha: op.candidate.candidateCommit, repo: { full_name: op.target.repository } },
      base: { ref: 'main', repo: { full_name: op.target.repository } } },
  };
  let approved = true;
  const adapter = createReleaseGitHub({ cwd: directory, executable: process.execPath, artifactDirectory: () => directory,
    authorize() { if (!approved) throw Error('Approval revoked.'); } }, async (executable, args, options) => {
    calls.push({ executable, args, options });
    let response = {};
    if (args[0] === 'release') {
      assert.equal(args[1], 'upload'); assert.equal(args.includes('--clobber'), false);
      const files = args.slice(3, args.indexOf('--repo'));
      for (const file of files) { const bytes = await readFile(file); state.assets.push({ name: basename(file), state: 'uploaded', size: bytes.length, digest: 'sha256:' + digest(bytes) }); }
      state.uploads++;
    } else {
      const method = args[4], endpoint = args[5], body = options.input === undefined ? undefined : JSON.parse(String(options.input));
      if (endpoint.endsWith('/pulls/17') && method === 'GET') response = state.pr;
      else if (endpoint === 'graphql') {
        assert.equal(method, 'POST'); assert.equal(body.variables.id, state.pr.node_id);
        assert.match(body.query, /markPullRequestReadyForReview/);
        state.pr.draft = false;
        if (state.afterReady) state.afterReady();
        response = { data: { markPullRequestReadyForReview: { pullRequest: { id: state.pr.node_id, isDraft: false } } } };
      } else if (endpoint.endsWith('/pulls/17/merge')) {
        assert.equal(method, 'PUT'); assert.deepEqual(body, { sha: op.candidate.candidateCommit, merge_method: 'squash' });
        state.pr = { ...state.pr, state: 'closed', merged: true, merged_at: now, merge_commit_sha: merged }; response = { merged: true, sha: merged };
      } else if (endpoint.includes('/git/ref/tags/')) { if (!state.tag) throw missing(); response = state.tag; }
      else if (endpoint.endsWith('/git/refs')) { state.tag = { ref: body.ref, object: { type: 'commit', sha: body.sha } }; response = state.tag; }
      else if (endpoint.includes('/releases/tags/')) { if (!state.release) throw missing(); response = state.release; }
      else if (endpoint.endsWith('/releases') && method === 'POST') {
        state.release = { ...body, id: 23, html_url: 'https://github.com/example/project/releases/tag/' + op.tag, published_at: null }; response = state.release;
      } else if (endpoint.endsWith('/releases/23/assets?per_page=100')) response = state.assets;
      else if (endpoint.endsWith('/releases/23') && method === 'PATCH') { state.release = { ...state.release, ...body, published_at: now }; response = state.release; }
      else throw Error('Unexpected GitHub fixture request: ' + endpoint);
    }
    return { exitCode: 0, stdout: Buffer.from(JSON.stringify(response)), stderr: Buffer.alloc(0) };
  });
  return { op, adapter, calls, state, directory, revoke() { approved = false; } };
}

test('merge uses the exact reviewed candidate SHA and preserves the actual squash merge identity', async t => {
  const h = await fixture(t);
  const before = await h.adapter.pullRequest(h.op, abort());
  assert.equal(before.headCommit, h.op.candidate.candidateCommit); assert.equal(before.merged, false);
  await h.adapter.merge(h.op, abort());
  const after = await h.adapter.pullRequest(h.op, abort());
  assert.equal(after.merged, true); assert.equal(after.mergeCommit, merged); assert.notEqual(after.mergeCommit, after.headCommit);
  const call = h.calls.find(item => item.args[4] === 'PUT');
  assert.equal(call.options.mode, 'contained'); assert.equal(call.options.env.GH_HOST, 'github.com');
  assert.equal(call.options.env.GH_DEBUG, undefined); assert.equal(call.options.env.GH_PROMPT_DISABLED, '1');
  assert.equal(call.args.includes('--admin'), false);
});

test('pull request observation rejects other repositories, branches, unsafe URLs and malformed merge receipts', async t => {
  const h = await fixture(t), exact = structuredClone(h.state.pr);
  for (const changes of [
    { html_url: 'https://evil.invalid/pull/17' }, { number: 18 }, { head: { ...exact.head, ref: 'unrelated' } },
    { base: { ...exact.base, repo: { full_name: 'other/project' } } }, { merged: true, merge_commit_sha: 'unknown', merged_at: now },
    { merged: true, merge_commit_sha: merged, merged_at: null },
  ]) {
    h.state.pr = { ...exact, ...changes };
    await assert.rejects(h.adapter.pullRequest(h.op, abort()), /exact pull request/);
  }
});

test('publication creates an exact tag and owned draft, uploads immutable assets, then confirms complete checksums', async t => {
  const h = await fixture(t);
  assert.equal(await h.adapter.inspectRelease(h.op, abort()), null);
  await h.adapter.publish(h.op, abort());
  assert.equal(h.state.tag.object.sha, merged); assert.equal(h.state.release.draft, false);
  assert.equal(h.state.uploads, 1);
  const receipt = await h.adapter.inspectRelease(h.op, abort());
  assert.deepEqual(receipt, { tag: h.op.tag, url: h.state.release.html_url, commit: merged, assets: h.op.build.artifacts, publishedAt: now });
  const before = h.calls.length;
  await h.adapter.publish(h.op, abort());
  assert.equal(h.calls.slice(before).some(item => item.args[0] === 'release' || item.args[4] !== 'GET'), false, 'published releases are observed without mutation');
});

test('interrupted publication resumes only its owned draft and uploads only missing assets', async t => {
  const h = await fixture(t);
  await h.adapter.publish(h.op, abort());
  h.state.release.draft = true; h.state.release.published_at = null;
  h.state.assets = h.state.assets.slice(0, 1); const before = h.calls.length;
  assert.equal(await h.adapter.inspectRelease(h.op, abort()), null, 'read-only reconciliation does not publish a draft');
  await h.adapter.publish(h.op, abort());
  const uploads = h.calls.slice(before).filter(item => item.args[0] === 'release');
  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0].args.slice(3, uploads[0].args.indexOf('--repo')).map(path => basename(path)), ['werk-release-manifest.json', 'SHA256SUMS']);
  assert.equal(h.state.assets.length, 3); assert.equal(h.state.release.draft, false);
});

test('release conflicts, changed tags and assets with unknown or mismatching digests never authorize overwrite', async t => {
  const h = await fixture(t);
  await h.adapter.publish(h.op, abort());
  const exact = structuredClone(h.state);
  for (const corrupt of [
    () => { h.state.tag.object.sha = 'f'.repeat(40); },
    () => { h.state.tag.object.type = 'tag'; },
    () => { h.state.release.body = 'A release owned by another publisher.'; },
    () => { h.state.assets[0].digest = null; },
    () => { h.state.assets[0].digest = 'sha256:' + 'f'.repeat(64); },
    () => { h.state.assets.push({ name: 'unexpected.zip', state: 'uploaded', size: 1, digest: 'sha256:' + 'a'.repeat(64) }); },
  ]) {
    Object.assign(h.state, structuredClone(exact)); corrupt(); const before = h.calls.length;
    await assert.rejects(h.adapter.publish(h.op, abort()));
    assert.equal(h.calls.slice(before).some(item => item.args[0] === 'release' || item.args[4] !== 'GET'), false);
  }
});

test('changed local artifact bytes and revoked approval block all publication mutations', async t => {
  const h = await fixture(t);
  await writeFile(join(h.directory, 'app.zip'), 'tampered bytes');
  await assert.rejects(h.adapter.publish(h.op, abort()), /artifact changed/); assert.equal(h.calls.length, 0);
  h.revoke();
  await assert.rejects(h.adapter.pullRequest(h.op, abort()), /revoked/);
  await assert.rejects(h.adapter.merge(h.op, abort()), /revoked/);
  assert.equal(h.calls.length, 0);
});

test('GitHub repository casing is normalized without weakening exact tag case', async t => {
  const h = await fixture(t); h.op.target.repository = 'EXAMPLE/PROJECT';
  assert.equal((await h.adapter.pullRequest(h.op, abort())).number, 17);
  await h.adapter.publish(h.op, abort());
  const receipt = await h.adapter.inspectRelease(h.op, abort());
  assert.equal(receipt.url, 'https://github.com/EXAMPLE/PROJECT/releases/tag/v1.0.0');
  h.state.release.html_url = 'https://github.com/example/project/releases/tag/V1.0.0';
  await assert.rejects(h.adapter.inspectRelease(h.op, abort()), /another destination/);
});


test('merge makes only the accepted draft ready, reobserves its head, and uses the expected-head merge guard', async t => {
  const h = await fixture(t); h.state.pr.draft = true;
  await h.adapter.pullRequest(h.op, abort());
  assert.equal(h.state.pr.draft, true, 'read-only observations never mark a draft ready');
  assert.equal(h.calls.some(item => item.args[5] === 'graphql'), false);
  await h.adapter.merge(h.op, abort());
  const readyAt = h.calls.findIndex(item => item.args[5] === 'graphql');
  const reobservedAt = h.calls.findIndex((item, index) => index > readyAt && item.args[5].endsWith('/pulls/17'));
  const mergeAt = h.calls.findIndex(item => item.args[4] === 'PUT');
  assert.ok(readyAt >= 0 && reobservedAt > readyAt && mergeAt > reobservedAt);
  assert.equal(h.state.pr.draft, false); assert.equal(h.state.pr.merged, true);
  const before = h.calls.length;
  await h.adapter.merge(h.op, abort());
  assert.equal(h.calls.slice(before).some(item => item.args[4] !== 'GET'), false, 'retry observes the existing merge without another readiness mutation');
});

test('a head change or approval revocation after draft readiness prevents merge', async t => {
  const h = await fixture(t); h.state.pr.draft = true;
  h.state.afterReady = () => { h.state.pr.head.sha = 'f'.repeat(40); };
  await assert.rejects(h.adapter.merge(h.op, abort()), /head changed/);
  assert.equal(h.calls.some(item => item.args[4] === 'PUT'), false);
  const revoked = await fixture(t); revoked.state.pr.draft = true;
  revoked.state.afterReady = () => revoked.revoke();
  await assert.rejects(revoked.adapter.merge(revoked.op, abort()), /revoked/);
  assert.equal(revoked.calls.some(item => item.args[4] === 'PUT'), false);
});
