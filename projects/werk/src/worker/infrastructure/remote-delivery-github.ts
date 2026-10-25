import { ObservedDuplicatePublication } from '../application/remote-delivery-integrity.js';
import { DomainError } from '../../shared/errors.js';
import { runProcess, type RunOptions, type RunResult } from '../../shared/process/launcher.js';
import { gitEnvironment } from '../../shared/git/environment.js';
import { candidatePublicationMarker, publicationMarker } from '../application/remote-delivery-runtime.js';
import { remotePublicationBranch } from '../application/remote-delivery-contracts.js';
import type { RemotePublication, RemotePublicationObservation } from '../application/remote-delivery-contracts.js';
import { findExecutable } from './providers.js';

const conflict = (message: string): never => { throw new DomainError('conflict', message); };
type Execute = (executable: string, args: string[], options: RunOptions) => Promise<RunResult>;
/** gh owns official host authentication. The worker neither reads nor persists its credentials. */
export function createGitHubPublication(options: { cwd: string; executable?: string; authorize?: (mutation: boolean) => void | Promise<void> }, execute: Execute = runProcess) {
  async function api(endpoint: string, signal: AbortSignal, body?: unknown, method?: 'PATCH') {
    const executable = options.executable ?? await findExecutable('gh');
    if (!executable) throw new DomainError('unavailable', 'Install GitHub CLI and authenticate it in the worker account before creating pull requests.');
    const env: NodeJS.ProcessEnv = { ...gitEnvironment('host'), GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat' };
    delete env.GH_DEBUG;
    await options.authorize?.(body !== undefined); signal.throwIfAborted();
    const result = await execute(executable, ['api', '--hostname', 'github.com', '--method', method ?? (body === undefined ? 'GET' : 'POST'), endpoint,
      '-H', 'Accept: application/vnd.github+json', ...(body === undefined ? [] : ['--input', '-'])],
    { cwd: options.cwd, env, mode: 'contained', observation: { kind: 'git', label: 'GitHub publication' }, signal,
      timeoutMs: 30000, maxOutputBytes: 1048576, ...(body === undefined ? {} : { input: JSON.stringify(body) }) });
    try { return JSON.parse(result.stdout.toString('utf8')) as unknown; }
    catch { throw new DomainError('unavailable', 'GitHub returned an unreadable publication response. Reconcile the saved operation before retrying.'); }
  }
  return {
    async findPullRequest(publication: RemotePublication, signal: AbortSignal, allowPreviousEvidence = false): Promise<RemotePublicationObservation['pullRequest'] | null> {
      const { target, candidate, predecessor } = publication, branch = remotePublicationBranch(publication);
      const marked = (body: unknown) => typeof body === 'string' && (body.includes(candidatePublicationMarker(publication)) ||
        allowPreviousEvidence && predecessor && body.includes(candidatePublicationMarker({ candidate: predecessor.candidate, target })));
      const query = new URLSearchParams({ state: 'all', head: target.repository.split('/')[0] + ':' + branch, base: target.base, per_page: '100' });
      const result = await api(`repos/${target.repository}/pulls?${query}`, signal);
      if (!Array.isArray(result)) return conflict('The pull request lookup returned an invalid response. Reconcile before retrying.');
      if (result.length >= 100) conflict('The pull request lookup was incomplete. Inspect the remote destination before retrying.');
      const matches = result.filter(value => value && typeof value === 'object' && value.head?.ref === branch && value.base?.ref === target.base &&
        String(value.head?.repo?.full_name).toLowerCase() === target.repository.toLowerCase() && String(value.base?.repo?.full_name).toLowerCase() === target.repository.toLowerCase());
      if (matches.length !== result.length) conflict('The pull request lookup returned another destination. Reconcile the exact repository and branch before continuing.');
      if (matches.length > 1) {
        const observed = matches.filter(value => value.head.sha === candidate.candidateCommit && marked(value.body) && Number.isSafeInteger(value.number) && value.number > 0 && typeof value.html_url === 'string' && value.html_url.toLowerCase() === `https://github.com/${target.repository}/pull/${value.number}`.toLowerCase());
        if (new Set(observed.map(value => value.number)).size > 1) throw new ObservedDuplicatePublication();
        conflict('More than one pull request matches this candidate branch. Resolve the ambiguity before continuing.');
      }
      if (!matches.length) return null;
      const found = matches[0];
      if (!allowPreviousEvidence && predecessor && found.number === predecessor.pullRequest.number && found.head.sha === candidate.candidateCommit &&
        typeof found.body === 'string' && found.body.includes(candidatePublicationMarker({ candidate: predecessor.candidate, target })) && !found.body.includes(candidatePublicationMarker(publication))) return null;
      if (found.head.sha !== candidate.candidateCommit || !marked(found.body))
        conflict('An existing pull request has different candidate content or publication identity. It was not replaced or duplicated.');
      if (predecessor && found.number !== predecessor.pullRequest.number) conflict('The retained request refers to another PR number. No replacement PR was created.');
      if (!Number.isSafeInteger(found.number) || found.number < 1 || !['open', 'closed'].includes(found.state) ||
        typeof found.html_url !== 'string' || found.html_url.toLowerCase() !== `https://github.com/${target.repository}/pull/${found.number}`.toLowerCase())
        conflict('The pull request response did not establish a safe, exact GitHub result.');
      return { number: found.number, url: found.html_url, state: found.merged_at ? 'merged' : found.state };
    },
    async updatePullRequest(publication: RemotePublication, title: string, body: string, signal: AbortSignal): Promise<void> {
      const predecessor = publication.predecessor;
      if (!publication.target.pullRequest || !predecessor) return conflict('Updating a PR requires its retained worker publication receipt.');
      if (!title.trim() || title.length > 200 || /[\r\n\x00]/.test(title) || Buffer.byteLength(body) > 60000 || body.includes('\0'))
        conflict('The proposed pull request title or body exceeds the supported content bounds.');
      const found = await this.findPullRequest(publication, signal, true);
      if (!found || found.state !== 'open' || found.number !== predecessor.pullRequest.number)
        return conflict('Only the retained open pull request can receive updated evidence.');
      await api(`repos/${publication.target.repository}/pulls/${found.number}`, signal,
        { title, body: body + '\n\n' + publicationMarker(publication) }, 'PATCH');
    },
    async createPullRequest(publication: RemotePublication, title: string, body: string, signal: AbortSignal): Promise<void> {
      if (publication.predecessor) conflict('Review rework must update its retained pull request instead of creating another.');
      if (!publication.target.pullRequest) conflict('The approved policy does not permit pull request creation.');
      if (!title.trim() || title.length > 200 || /[\r\n\x00]/.test(title) || Buffer.byteLength(body) > 60000 || body.includes('\0'))
        conflict('The proposed pull request title or body exceeds the supported content bounds.');
      const marker = publicationMarker(publication);
      await api(`repos/${publication.target.repository}/pulls`, signal, { title, body: body + '\n\n' + marker,
        head: remotePublicationBranch(publication), base: publication.target.base, draft: publication.target.draft, maintainer_can_modify: false });
    },
  };
}
