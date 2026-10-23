import type { RemotePublication } from './remote-delivery-contracts.js';

/** Publication observations remain distinct from local review, acceptance and merge authority. */
export function remotePublicationMarkdown(publications: RemotePublication[]): string {
  const text = (value: string) => value.replaceAll('<!--', '&lt;!--').replace(/[\r\n]+/g, ' ');
  return '## Remote publication\n\nEach observation belongs to the recorded candidate. Publication does not accept or merge the Feature Request.\n\n' + publications.map(item => {
    const pr = item.observation?.pullRequest;
    const link = pr && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(item.target.repository) && Number.isSafeInteger(pr.number) && pr.number > 0
      ? `\n\nGitHub pull request: [#${pr.number}](https://github.com/${item.target.repository}/pull/${pr.number}) · observed ${text(pr.state)}.` : '';
    return `### ${text(item.operationId)} · ${item.action === 'push' ? 'Candidate push' : 'Pull request creation'}\n\nState: ${text(item.status)}\n\nDestination: ${text(item.target.repository)} · base ${text(item.target.base)}\n\nCandidate: ${text(item.candidate.candidateCommit)} on ${text(item.candidate.branch)}\n\n${text(item.detail)}${link}`;
  }).join('\n\n');
}
