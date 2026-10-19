/** Shared branch publication keeps these independent bounds even when local candidate limits are raised. */
export interface SharedFeaturePublicationLimits { patchMaxBytes: number; changedFilesMax: number; }
export const sharedFeaturePublicationLimits: Readonly<SharedFeaturePublicationLimits> = Object.freeze({ patchMaxBytes: 131072, changedFilesMax: 32 });

/** A retained admission can stay stricter, but cannot weaken the publisher's current hard bounds. */
export function sharedFeaturePublicationBounds(frozen: SharedFeaturePublicationLimits = sharedFeaturePublicationLimits): SharedFeaturePublicationLimits {
  return { patchMaxBytes: Math.min(frozen.patchMaxBytes, sharedFeaturePublicationLimits.patchMaxBytes), changedFilesMax: Math.min(frozen.changedFilesMax, sharedFeaturePublicationLimits.changedFilesMax) };
}

/** UTF-8 bytes and actual Git file headers; implementation checks and publication measure a patch identically. */
export function sharedFeaturePublicationMeasure(patch: string): { patchBytes: number; changedFileCount: number } {
  return { patchBytes: Buffer.byteLength(patch), changedFileCount: [...patch.matchAll(/^diff --git /gm)].length };
}

/** Preflight generated Git patches before publication; the repository still validates actual indexed changes. */
export function sharedFeaturePublicationIssue(patch: string, frozen?: SharedFeaturePublicationLimits): string | undefined {
  const limits = sharedFeaturePublicationBounds(frozen);
  const { patchBytes: bytes, changedFileCount: files } = sharedFeaturePublicationMeasure(patch);
  if (bytes > limits.patchMaxBytes)
    return `The retained candidate patch is ${bytes.toLocaleString('en-US')} bytes; shared feature publication allows at most ${limits.patchMaxBytes.toLocaleString('en-US')} bytes${limits.patchMaxBytes === 131072 ? ' (128 KiB)' : ''}.`;
  if (files > limits.changedFilesMax)
    return `The retained candidate changes ${files} files; shared feature publication allows at most ${limits.changedFilesMax} changed files.`;
}
