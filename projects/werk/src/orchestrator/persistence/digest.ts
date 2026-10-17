import { createHash } from "node:crypto";

/** Stable payload and credential digests used by persistence receipts. */
export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
