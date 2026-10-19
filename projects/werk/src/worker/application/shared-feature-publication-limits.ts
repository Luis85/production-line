/** Shared branch publication keeps these independent bounds even when local candidate limits are raised. */
export interface SharedFeaturePublicationLimits { patchMaxBytes: number; changedFilesMax: number; }
export const sharedFeaturePublicationLimits: Readonly<SharedFeaturePublicationLimits> = Object.freeze({ patchMaxBytes: 131072, changedFilesMax: 32 });

/** UTF-8 bytes and actual Git file headers; implementation checks and publication measure a patch identically. */
export function sharedFeaturePublicationMeasure(patch: string): { patchBytes: number; changedFileCount: number } {
  return { patchBytes: Buffer.byteLength(patch), changedFileCount: [...patch.matchAll(/^diff --git /gm)].length };
}

/** Preflight generated Git patches before publication; the repository still validates actual indexed changes. */
export function sharedFeaturePublicationIssue(patch: string): string | undefined {
  const { patchBytes: bytes, changedFileCount: files } = sharedFeaturePublicationMeasure(patch);
  if (bytes > sharedFeaturePublicationLimits.patchMaxBytes)
    return `The retained candidate patch is ${bytes.toLocaleString('en-US')} bytes; shared feature publication allows at most ${sharedFeaturePublicationLimits.patchMaxBytes.toLocaleString('en-US')} bytes (128 KiB).`;
  if (files > sharedFeaturePublicationLimits.changedFilesMax)
    return `The retained candidate changes ${files} files; shared feature publication allows at most ${sharedFeaturePublicationLimits.changedFilesMax} changed files.`;
}
