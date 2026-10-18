import { createHash } from "node:crypto";
import { join } from "node:path";
import { readBoundedFile, assertDirectory } from "./journal/files.js";
                                                          
/** Recheck the retained patch before either normal completion or a later gate release. */
export async function verifyReviewArtifact(
  directory        ,
  lease               ,
  review                                 ,
)                {
  if (
    !lease ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(lease) ||
    review.artifactPath !== `review/${lease}/change.patch`
  )
    throw Error("Review artifact identity mismatch");
  if (
    !Number.isSafeInteger(review.patchBytes) ||
    review.patchBytes < 1 ||
    review.patchBytes > 1048576 ||
    !/^[a-f0-9]{64}$/.test(review.patchSha256)
  )
    throw Error("Invalid review artifact metadata");
  await assertDirectory(directory);
  await assertDirectory(join(directory, "review"));
  await assertDirectory(join(directory, "review", lease));
  const patch = await readBoundedFile(
    join(directory, review.artifactPath),
    1048576,
    true,
  );
  if (
    Buffer.byteLength(patch) !== review.patchBytes ||
    createHash("sha256").update(patch).digest("hex") !== review.patchSha256
  )
    throw Error(
      "Review artifact is missing or changed; restore evidence before completing",
    );
}
