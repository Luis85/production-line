import { gateDigest, type WorkerRequest } from './request-gates.js';
import type { DeliveryRelease } from './release-contracts.js';
import type { ReleaseProjection } from './release-markdown.js';

export function sharedReleaseConfigured(request: WorkerRequest | null | undefined): boolean {
  return !!(request?.input.context as { deliveryPolicy?: { configuration?: { release?: unknown } } } | undefined)?.deliveryPolicy?.configuration?.release;
}
/** Public source projections deliberately omit command arguments, private paths and accepted runtime authority. */
export function sharedReleaseProjection(release: DeliveryRelease | undefined): ReleaseProjection {
  return { operations: (release?.operations ?? []).map(({ operationId, action, status, detail }) => ({ operationId, action, status, detail })),
    ...(release?.merge ? { merge: { ...release.merge } } : {}), ...(release?.build ? { build: { ...release.build, artifacts: release.build.artifacts.map(asset => ({ ...asset })) } } : {}),
    ...(release?.published ? { published: { ...release.published, assets: release.published.assets.map(asset => ({ ...asset })) } } : {}) };
}
export function sharedReleasePhase(request: WorkerRequest | null | undefined): string | null {
  if (!request || !sharedReleaseConfigured(request)) return null;
  const release = request.delivery?.release;
  if (release?.published) return 'done';
  if (request.recoveryHold || request.deliveryHolds?.length || request.delivery?.holds.length || request.delivery?.control) return 'release_blocked';
  const latest = release?.operations.at(-1);
  if (latest?.status === 'pending') return latest.action === 'merge' ? 'merging' : latest.action === 'build' ? 'building' : 'publishing_release';
  if (latest?.status === 'unknown') return 'release_outcome_unknown';
  if (latest && ['failed', 'not_observed'].includes(latest.status)) return 'release_failed';
  if (release?.build) return 'built';
  if (release?.merge) return 'merged';
  return request.attestation && request.phase === 'done' ? 'accepted' : null;
}
export function sameSharedRelease(first: ReleaseProjection | undefined, second: ReleaseProjection): boolean {
  return gateDigest(first ?? { operations: [] }) === gateDigest(second);
}
