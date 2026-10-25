import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError } from '../../shared/errors.js';
import { gitEnvironment } from '../../shared/git/environment.js';
import { ProcessRunError, runProcess, type RunOptions, type RunResult } from '../../shared/process/launcher.js';
import { releaseTag, validateReleasePolicy } from '../application/release-policy.js';
import type { ReleaseOperation, ReleasePort, ReleasePublishedReceipt } from '../application/release-contracts.js';
import { findExecutable } from './providers.js';

type Execute = (executable: string, args: string[], options: RunOptions) => Promise<RunResult>;
type Json = Record<string, unknown>;
function conflict(message: string): never { throw new DomainError('conflict', message); }
const sha = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
function record(value: unknown): Json { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : conflict('GitHub returned an invalid release response.'); }
function releaseURLMatches(value: unknown, repository: string, tag: string): boolean {
  const suffix = '/releases/tag/' + tag;
  return typeof value === 'string' && value.endsWith(suffix) && value.slice(0, -suffix.length).toLowerCase() === 'https://github.com/' + repository.toLowerCase();
}
function marker(operation: ReleaseOperation): string {
  return '<!-- werk-release:' + createHash('sha256').update(JSON.stringify({ request: operation.candidate.requestId, run: operation.candidate.runId,
    candidate: operation.candidate.candidateCommit, commit: operation.mergeCommit, manifest: operation.build?.manifestDigest, tag: operation.tag })).digest('hex') + ' -->';
}
/** Official gh authentication stays outside request data. All observations are bounded and destination-bound. */
export function createReleaseGitHub(options: {
  cwd: string; executable?: string; authorize?: (mutation: boolean) => void | Promise<void>;
  artifactDirectory(operation: ReleaseOperation): string;
}, execute: Execute = runProcess): Pick<ReleasePort, 'pullRequest' | 'merge' | 'inspectRelease' | 'publish'> {
  async function invoke(args: string[], signal: AbortSignal, mutation: boolean, input?: unknown) {
    const executable = options.executable ?? await findExecutable('gh');
    if (!executable) throw new DomainError('unavailable', 'Install GitHub CLI and authenticate the worker account before release operations.');
    const env: NodeJS.ProcessEnv = { ...gitEnvironment('host'), GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat' };
    delete env.GH_DEBUG;
    await options.authorize?.(mutation); signal.throwIfAborted();
    return execute(executable, args, { cwd: options.cwd, env, mode: 'contained', observation: { kind: 'git', label: 'GitHub release' },
      signal, timeoutMs: 120000, maxOutputBytes: 1048576, ...(input === undefined ? {} : { input: JSON.stringify(input) }) });
  }
  async function api(endpoint: string, signal: AbortSignal, method = 'GET', input?: unknown, missing = false): Promise<unknown> {
    try {
      const response = await invoke(['api', '--hostname', 'github.com', '--method', method, endpoint,
        '-H', 'Accept: application/vnd.github+json', ...(input === undefined ? [] : ['--input', '-'])], signal, method !== 'GET', input);
      return JSON.parse(response.stdout.toString('utf8')) as unknown;
    } catch (error) {
      if (missing && error instanceof ProcessRunError && error.reason === 'exit') {
        try { if (JSON.parse(error.result.stdout.toString('utf8')).status === '404' || JSON.parse(error.result.stdout.toString('utf8')).status === 404) return null; } catch { /* An unstructured failure never proves absence. */ }
      }
      throw error;
    }
  }
  function subject(operation: ReleaseOperation) {
    validateReleasePolicy(operation.target);
    if (!Number.isSafeInteger(operation.pullRequest.number) || operation.pullRequest.number < 1 || !sha(operation.candidate.candidateCommit)) conflict('Release requires the exact retained pull request and candidate.');
    return 'repos/' + operation.target.repository;
  }
  async function observedTag(operation: ReleaseOperation, signal: AbortSignal) {
    const root = subject(operation), tag = releaseTag(operation.tag, operation.target.tagPrefix);
    if (!sha(operation.mergeCommit) || operation.build?.commit !== operation.mergeCommit) conflict('Release requires an immutable build of the exact merged commit.');
    const value = await api(root + '/git/ref/tags/' + encodeURIComponent(tag), signal, 'GET', undefined, true);
    if (value === null) return null;
    const ref = record(value), object = record(ref.object);
    if (ref.ref !== 'refs/tags/' + tag || object.type !== 'commit' || object.sha !== operation.mergeCommit) conflict('The release tag already identifies another commit or tag object. It was not changed.');
    return tag;
  }
  async function observedRelease(operation: ReleaseOperation, signal: AbortSignal) {
    const root = subject(operation), tag = releaseTag(operation.tag, operation.target.tagPrefix);
    const value = await api(root + '/releases/tags/' + encodeURIComponent(tag), signal, 'GET', undefined, true);
    if (value === null) return null;
    const release = record(value);
    if (!Number.isSafeInteger(release.id) || Number(release.id) < 1 || release.tag_name !== tag ||
      !releaseURLMatches(release.html_url, operation.target.repository, tag) ||
      typeof release.body !== 'string' || !release.body.includes(marker(operation)) || typeof release.draft !== 'boolean' || release.prerelease !== operation.target.prerelease)
      conflict('An existing release has another destination, owner or release policy. It was not changed.');
    return release;
  }
  async function assets(operation: ReleaseOperation, release: Json, signal: AbortSignal, complete: boolean) {
    const raw = await api(subject(operation) + '/releases/' + release.id + '/assets?per_page=100', signal);
    if (!Array.isArray(raw) || raw.length >= 100 || !operation.build) conflict('The release asset inventory is incomplete.');
    const expected = operation.build.artifacts;
    const names = new Set<string>();
    for (const value of raw) {
      const asset = record(value), match = expected.find(item => item.name === asset.name);
      if (!match || names.has(match.name) || asset.state !== 'uploaded' || asset.size !== match.bytes || asset.digest !== 'sha256:' + match.sha256)
        conflict('Release assets conflict with the retained build manifest or lack verified checksums. No asset was overwritten.');
      names.add(match.name);
    }
    if (complete && names.size !== expected.length) conflict('The published release is missing required build assets.');
    return names;
  }
  async function inspect(operation: ReleaseOperation, signal: AbortSignal): Promise<ReleasePublishedReceipt | null> {
    if (!await observedTag(operation, signal)) return null;
    const release = await observedRelease(operation, signal);
    if (!release) return null;
    await assets(operation, release, signal, release.draft === false);
    if (release.draft) return null;
    if (!date(release.published_at)) conflict('The release has no confirmed publication time.');
    return { tag: operation.tag!, url: 'https://github.com/' + operation.target.repository + '/releases/tag/' + operation.tag, commit: operation.mergeCommit!, assets: structuredClone(operation.build!.artifacts), publishedAt: release.published_at };
  }
  async function observedPullRequest(operation: ReleaseOperation, signal: AbortSignal) {
      const root = subject(operation), result = record(await api(root + '/pulls/' + operation.pullRequest.number, signal));
      const head = record(result.head), base = record(result.base), repository = operation.target.repository.toLowerCase();
      if (result.number !== operation.pullRequest.number || typeof result.html_url !== 'string' || result.html_url.toLowerCase() !== operation.pullRequest.url.toLowerCase() ||
        result.html_url.toLowerCase() !== ('https://github.com/' + operation.target.repository + '/pull/' + operation.pullRequest.number).toLowerCase() ||
        head.ref !== operation.pullRequest.branch || base.ref !== operation.target.base ||
        String(record(head.repo).full_name).toLowerCase() !== repository || String(record(base.repo).full_name).toLowerCase() !== repository ||
        !sha(head.sha) || !['open', 'closed'].includes(String(result.state)) || typeof result.merged !== 'boolean' || typeof result.draft !== 'boolean' ||
        typeof result.node_id !== 'string' || !/^[A-Za-z0-9_=-]{1,256}$/.test(result.node_id) ||
        result.merged && (!sha(result.merge_commit_sha) || !date(result.merged_at)))
        conflict('GitHub did not establish the exact pull request, repository, branch and merge identity.');
      return { draft: result.draft, nodeId: result.node_id, receipt: { number: Number(result.number), url: operation.pullRequest.url, branch: String(head.ref), base: String(base.ref), headCommit: head.sha,
        closed: result.state === 'closed', merged: result.merged, mergeCommit: result.merged ? String(result.merge_commit_sha) : null, mergedAt: result.merged ? String(result.merged_at) : null } };
  }
  function acceptedHead(operation: ReleaseOperation, observed: Awaited<ReturnType<typeof observedPullRequest>>) {
    if (observed.receipt.headCommit !== operation.candidate.candidateCommit || observed.receipt.closed && !observed.receipt.merged)
      conflict('The pull request head changed or it closed before the accepted merge. Refresh and review its current candidate.');
  }
  return {
    async pullRequest(operation, signal) { return (await observedPullRequest(operation, signal)).receipt; },
    async merge(operation, signal) {
      let observed = await observedPullRequest(operation, signal);
      acceptedHead(operation, observed);
      if (observed.receipt.merged) return;
      if (observed.draft) {
        const result = record(await api('graphql', signal, 'POST', {
          query: 'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id isDraft}}}', variables: { id: observed.nodeId },
        }));
        const ready = record(record(record(result.data).markPullRequestReadyForReview).pullRequest);
        if (result.errors || ready.id !== observed.nodeId || ready.isDraft !== false) conflict('GitHub did not confirm that the accepted draft is ready for review. Reconcile its saved merge intent.');
        // Ready is a remote mutation within the persisted merge intent. A fresh observation
        // prevents a concurrent candidate update from inheriting the prior acceptance.
        observed = await observedPullRequest(operation, signal);
        acceptedHead(operation, observed);
        if (observed.receipt.merged) return;
        if (observed.draft) conflict('The accepted pull request remains a draft. Reconcile its current GitHub state.');
      }
      const response = record(await api(subject(operation) + '/pulls/' + operation.pullRequest.number + '/merge', signal, 'PUT',
        { sha: operation.candidate.candidateCommit, merge_method: operation.target.mergeMethod }));
      if (response.merged !== true || !sha(response.sha)) conflict('GitHub did not confirm merge. Inspect repository checks, reviews and branch protections.');
    },
    inspectRelease: inspect,
    async publish(operation, signal) {
      const root = subject(operation), tag = releaseTag(operation.tag, operation.target.tagPrefix);
      if (!operation.build || !sha(operation.mergeCommit)) conflict('Publish requires the retained exact merged build.');
      const directory = options.artifactDirectory(operation), paths = new Map<string, string>();
      for (const artifact of operation.build.artifacts) {
        if (!/^[^/\\\x00-\x1f#]+$/.test(artifact.name) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) conflict('Release artifact identity is invalid.');
        const path = join(directory, artifact.name), info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.bytes || info.size > 67108864 || createHash('sha256').update(await readFile(path)).digest('hex') !== artifact.sha256)
          conflict('A retained release artifact changed before publication. Rebuild or restore its recorded bytes.');
        if (path.includes('#')) conflict('GitHub upload paths cannot contain a label separator. Choose a worker state directory without #.');
        paths.set(artifact.name, path);
      }
      if (!await observedTag(operation, signal)) {
        await api(root + '/git/refs', signal, 'POST', { ref: 'refs/tags/' + tag, sha: operation.mergeCommit });
        if (!await observedTag(operation, signal)) conflict('The release tag was not observed after creation.');
      }
      let release = await observedRelease(operation, signal);
      if (release?.draft === false) { await inspect(operation, signal); return; }
      if (!release) {
        await api(root + '/releases', signal, 'POST', { tag_name: tag, target_commitish: operation.mergeCommit, name: tag,
          body: 'Verified worker release for ' + operation.candidate.requestId + '.\n\n' + marker(operation), draft: true, prerelease: operation.target.prerelease });
        release = await observedRelease(operation, signal);
        if (!release) conflict('The saved draft release could not be observed after creation.');
      }
      const present = await assets(operation, release, signal, false);
      const missing = operation.build.artifacts.filter(item => !present.has(item.name));
      if (missing.length) await invoke(['release', 'upload', tag, ...missing.map(item => paths.get(item.name)!), '--repo', operation.target.repository], signal, true);
      await assets(operation, release, signal, true);
      await api(root + '/releases/' + release.id, signal, 'PATCH', { draft: false, prerelease: operation.target.prerelease, make_latest: operation.target.prerelease ? 'false' : 'true' });
    },
  };
}
