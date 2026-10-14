import { DomainError } from '../errors.js';
/** Bounded private request; remote response bodies never become diagnostic errors. */
export async function privateJson(url: URL, credential: string, method = 'GET', body?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<any> {
  try {
    const response = await fetch(url, { method, redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 12000)]) : AbortSignal.timeout(options.timeoutMs ?? 12000), headers: { authorization: 'Bearer ' + credential, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) { await response.body?.cancel(); throw new DomainError('unavailable', 'The remote component rejected this action. Check access, session state and connectivity.'); }
    const reader = response.body?.getReader(); if (!reader) throw Error('Empty response');
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 1048576) { await reader.cancel(); throw Error('Response limit'); } chunks.push(chunk.value); } } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError('unavailable', 'The remote component is unavailable. Check its address and retry.'); }
}
