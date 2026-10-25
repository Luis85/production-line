import type { DeliveryRelease } from './release-contracts.js';
export type ReleaseProjection = Pick<DeliveryRelease, 'merge' | 'build' | 'published'> & {
  operations: { operationId: string; action: string; status: string; detail: string }[];
};
/** Share observations and hashes without private build commands or filesystem locations. */
export function releaseMarkdown(release: ReleaseProjection): string {
  const safe = (value: string) => value.replaceAll('<!--', '&lt;!--').replace(/[\r\n]+/g, ' ');
  const merged = release.merge ? 'Merged commit: ' + safe(release.merge.mergeCommit) : 'Merged commit: not confirmed';
  const built = release.build ? 'Build commit: ' + safe(release.build.commit) + '\nManifest SHA-256: ' + safe(release.build.manifestDigest) + '\n\n' + release.build.artifacts.map(asset => '- ' + safe(asset.name) + ': ' + asset.bytes + ' bytes; SHA-256 ' + safe(asset.sha256)).join('\n') : 'Build: not confirmed';
  const published = release.published ? 'Published release: ' + safe(release.published.url) + '\nTag: ' + safe(release.published.tag) + '\nPublished commit: ' + safe(release.published.commit) : 'Release publication: not confirmed';
  return '## Merge, build and release\n\n' + merged + '\n\n' + built + '\n\n' + published + '\n\n' + release.operations.map(item => '- ' + safe(item.operationId) + ' · ' + safe(item.action) + ' · ' + safe(item.status) + ': ' + safe(item.detail)).join('\n');
}
