import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRemoteDeliveryGit } from '../../src/worker/dist/worker/infrastructure/remote-delivery-git.js';
import { createGitHubPublication } from '../../src/worker/dist/worker/infrastructure/remote-delivery-github.js';
import { FeatureGitIo } from '../../src/worker/dist/worker/infrastructure/features/git-io.js';
import { publicationMarker } from '../../src/worker/dist/worker/application/remote-delivery-runtime.js';
import { publication, target } from './remote-delivery-fixtures.mjs';
import { cleanup } from './fixture-cleanup.mjs';

prepareNativeProcessFixture();

const signal = () => new AbortController().signal;
const git = (directory, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

test('create-only candidate push preserves developer checkout and rejects an ancestor ref appearing after inspection', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-remote-'))), repository = join(directory, 'repo'), remote = join(directory, 'remote.git');
  cleanup(t, () => rm(directory, { recursive: true, force: true })); await mkdir(repository); await mkdir(remote);
  git(remote, 'init', '--bare'); git(repository, 'init', '-b', 'main'); git(repository, 'config', 'user.name', 'Fixture'); git(repository, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repository, 'value.txt'), 'baseline\n'); git(repository, 'add', '.'); git(repository, 'commit', '-m', 'Baseline');
  const baseline = git(repository, 'rev-parse', 'HEAD');
  await writeFile(join(repository, 'value.txt'), 'candidate\n'); git(repository, 'add', '.'); git(repository, 'commit', '-m', 'Candidate');
  const commit = git(repository, 'rev-parse', 'HEAD');
  await writeFile(join(repository, 'value.txt'), 'staged\n'); git(repository, 'add', '.'); await writeFile(join(repository, 'value.txt'), 'unstaged\n'); await writeFile(join(repository, 'keep.txt'), 'untracked\n');
  const before = { head: git(repository, 'rev-parse', 'HEAD'), index: git(repository, 'write-tree'), status: git(repository, 'status', '--porcelain=v1') };
  const io = new FeatureGitIo({ repository, stateDirectory: join(directory, 'state'), remote: 'origin' }), output = io.output.bind(io);
  const calls = []; let destination = 'https://github.com/example/project.git';
  // Production validates the approved GitHub URL; this fixture only redirects transport to a real local bare Git repository.
  io.output = async (cwd, args, abort, input) => {
    calls.push(args);
    if (args[0] === 'remote') return destination + '\n';
    return output(cwd, args.map(value => value === destination ? remote : value), abort, input);
  };
  const adapter = createRemoteDeliveryGit({ repository, stateDirectory: join(directory, 'state') }, io);
  const candidate = { ...publication().candidate, baseline, candidateCommit: commit };
  assert.equal(await adapter.branch(target, candidate.branch, signal()), null);
  await adapter.push(target, candidate, signal());
  assert.equal(await adapter.branch(target, candidate.branch, signal()), commit);
  assert.equal(git(remote, 'rev-parse', `refs/heads/${candidate.branch}`), commit);
  const racing = { ...candidate, branch: 'werk/delivery/racing' };
  assert.equal(await adapter.branch(target, racing.branch, signal()), null);
  git(remote, 'update-ref', `refs/heads/${racing.branch}`, baseline);
  await assert.rejects(adapter.push(target, racing, signal()));
  assert.equal(git(remote, 'rev-parse', `refs/heads/${racing.branch}`), baseline, 'even a fast-forwardable ancestor cannot be replaced by this create-only publication');
  assert.deepEqual({ head: git(repository, 'rev-parse', 'HEAD'), index: git(repository, 'write-tree'), status: git(repository, 'status', '--porcelain=v1') }, before);
  assert.equal(await readFile(join(repository, 'value.txt'), 'utf8'), 'unstaged\n'); assert.equal(await readFile(join(repository, 'keep.txt'), 'utf8'), 'untracked\n');
  const push = calls.find(args => args[0] === 'push');
  assert.ok(push.includes(`--force-with-lease=refs/heads/${candidate.branch}:`)); assert.ok(push.includes('--no-verify')); assert.ok(push.includes('--no-follow-tags'));
  for (const url of ['git@github.com:example/project.git', 'ssh://git@github.com/example/project.git']) {
    destination = url; assert.equal(await adapter.branch(target, candidate.branch, signal()), commit);
  }
  for (const url of ['https://github.com/other/project.git', 'https://secret@github.com/example/project.git', 'https://github.com.evil.invalid/example/project',
    'git@other.invalid:example/project.git', 'https://github.com/example/project?secret=x', 'ssh://git@github.com:2222/example/project.git', remote]) {
    destination = url; const count = calls.length;
    await assert.rejects(adapter.push(target, candidate, signal()), /approved GitHub repository/);
    assert.equal(calls.slice(count).some(args => args[0] === 'push'), false);
  }
});

function github() {
  const item = publication('pull_request'), calls = [];
  const exact = { number: 17, html_url: 'https://github.com/example/project/pull/17', state: 'open', merged_at: null,
    head: { ref: item.candidate.branch, sha: item.candidate.candidateCommit, repo: { full_name: target.repository } },
    base: { ref: target.base, repo: { full_name: target.repository } }, body: 'Review this candidate.\n' + publicationMarker(item) };
  /** @type {unknown} */ let response = [exact];
  const adapter = createGitHubPublication({ cwd: process.cwd(), executable: process.execPath }, async (executable, args, options) => {
    calls.push({ executable, args, options }); return { exitCode: 0, stdout: Buffer.from(JSON.stringify(response)), stderr: Buffer.alloc(0) };
  });
  return { item, exact, calls, adapter, response(value) { response = value; } };
}

test('GitHub reconciliation requires exact head, base, commit, marker, safe URL and unambiguous complete lookup', async () => {
  const h = github();
  assert.deepEqual(await h.adapter.findPullRequest(h.item, signal()), { number: 17, url: h.exact.html_url, state: 'open' });
  const args = h.calls[0].args;
  assert.deepEqual(args.slice(0, 5), ['api', '--hostname', 'github.com', '--method', 'GET']);
  const query = new URL('https://api.github.com/' + args[5]);
  assert.equal(query.searchParams.get('state'), 'all'); assert.equal(query.searchParams.get('head'), 'example:' + h.item.candidate.branch);
  assert.equal(query.searchParams.get('base'), 'main'); assert.equal(query.searchParams.get('per_page'), '100');
  for (const response of [[{ ...h.exact, head: { ...h.exact.head, sha: 'f'.repeat(40) } }], [{ ...h.exact, body: 'Unrelated user PR.' }],
    [{ ...h.exact, base: { ...h.exact.base, ref: 'other-base' } }], [{ ...h.exact, html_url: 'https://evil.invalid/17' }], [h.exact, h.exact], Array(100).fill(h.exact)]) {
    h.response(response); await assert.rejects(h.adapter.findPullRequest(h.item, signal()));
  }
  h.response([]); assert.equal(await h.adapter.findPullRequest(h.item, signal()), null);
  h.response([{ ...h.exact, state: 'closed', merged_at: '2026-10-20T00:00:00Z' }]); assert.equal((await h.adapter.findPullRequest(h.item, signal())).state, 'merged');
});

test('PR creation uses authenticated explicit REST JSON with no implicit push, fork or merge', async () => {
  const h = github(); h.response({ number: 17 });
  await h.adapter.createPullRequest(h.item, 'Feature candidate', 'Inspect exact commit.', signal());
  const { args, options } = h.calls[0];
  assert.deepEqual(args, ['api', '--hostname', 'github.com', '--method', 'POST', 'repos/example/project/pulls', '-H', 'Accept: application/vnd.github+json', '--input', '-']);
  const body = JSON.parse(options.input);
  assert.deepEqual(body, { title: 'Feature candidate', body: 'Inspect exact commit.\n\n' + publicationMarker(h.item), head: h.item.candidate.branch, base: 'main', draft: true, maintainer_can_modify: false });
  assert.equal(options.mode, 'contained'); assert.equal(options.timeoutMs, 30000); assert.equal(options.env.GH_PROMPT_DISABLED, '1'); assert.equal(options.env.GH_DEBUG, undefined);
  assert.equal(options.cwd, process.cwd());
  await assert.rejects(h.adapter.createPullRequest(h.item, 'Invalid\ntitle', 'Body', signal()));
  assert.equal(h.calls.length, 1);
});


test('remote adapters recheck authority after local inspection and before network execution', async () => {
  let approved = true; const calls = [];
  const io = new FeatureGitIo({ repository: process.cwd(), stateDirectory: process.cwd(), remote: 'origin' });
  io.root = async () => ({ path: process.cwd(), commonDirectory: process.cwd() });
  io.output = async (cwd, args) => { calls.push(args); if (args[0] === 'remote') { approved = false; return 'https://github.com/example/project.git\n'; } throw Error('Remote network must not run.'); };
  const adapter = createRemoteDeliveryGit({ repository: process.cwd(), stateDirectory: process.cwd(), authorize() { if (!approved) throw Error('Publication approval was revoked.'); } }, io);
  await assert.rejects(adapter.push(target, publication().candidate, signal()), /revoked/);
  assert.equal(calls.some(args => args[0] === 'push'), false);
  approved = true;
  await assert.rejects(adapter.branch(target, publication().candidate.branch, signal()), /revoked/);
  assert.equal(calls.some(args => args[0] === 'ls-remote'), false);
  let requests = 0;
  const github = createGitHubPublication({ cwd: process.cwd(), executable: process.execPath, authorize() { throw Error('Publication approval was revoked.'); } }, async () => { requests++; return { exitCode: 0, stdout: Buffer.from('{}'), stderr: Buffer.alloc(0) }; });
  await assert.rejects(github.createPullRequest(publication('pull_request'), 'Candidate', 'Review.', signal()), /revoked/);
  await assert.rejects(github.findPullRequest(publication('pull_request'), signal()), /revoked/);
  assert.equal(requests, 0);
});
