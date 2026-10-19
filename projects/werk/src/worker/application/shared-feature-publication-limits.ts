/** Shared branch publication keeps these independent bounds even when local candidate limits are raised. */
export const sharedFeaturePublicationLimits = Object.freeze({ patchMaxBytes: 131072, changedFilesMax: 32 });

/** Preflight generated Git patches before publication; the repository still validates actual indexed changes. */
export function sharedFeaturePublicationIssue(patch: string): string | undefined {
  const bytes = Buffer.byteLength(patch), files = [...patch.matchAll(/^diff --git /gm)].length;
  if (bytes > sharedFeaturePublicationLimits.patchMaxBytes)
    return `The retained candidate patch is ${bytes.toLocaleString('en-US')} bytes; shared feature publication allows at most ${sharedFeaturePublicationLimits.patchMaxBytes.toLocaleString('en-US')} bytes (128 KiB).`;
  if (files > sharedFeaturePublicationLimits.changedFilesMax)
    return `The retained candidate changes ${files} files; shared feature publication allows at most ${sharedFeaturePublicationLimits.changedFilesMax} changed files.`;
}
