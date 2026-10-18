/** Shared publication refusal only; size, encoding and patch-format rules belong to each caller. */
export function containsSensitivePatchMaterial(patch        )          {
  return /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/.test(patch);
}
