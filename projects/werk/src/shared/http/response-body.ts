/** Byte collection only: adapters retain their own status, decoding and error policy. */
export class ResponseBodyLimitError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super('Response body exceeds its byte limit');
    this.name = 'ResponseBodyLimitError';
    this.limit = limit;
  }
}
export async function readResponseBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  options: { cancel?: 'overflow' | 'always' } = {},
): Promise<Uint8Array> {
  const reader = body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        if (options.cancel !== 'always') await reader.cancel();
        throw new ResponseBodyLimitError(limit);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    // Provider streams cancel even on read failure; normal HTTP reads cancel only on overflow.
    if (options.cancel === 'always') await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
