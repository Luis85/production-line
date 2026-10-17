import { withOwnedResponse } from './transport.js';
import { readResponseBody } from './response-body.js';
import { DomainError } from '../errors.js';
/** Bounded private request; remote response bodies never become diagnostic errors. */
export async function privateJson(url: URL, credential: string, method = 'GET', body?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
  try {
    return await withOwnedResponse(url, { method, redirect: 'error', signal: options.signal, headers: { authorization: 'Bearer ' + credential, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, options.timeoutMs ?? 12000, async response => {
      if (!response.ok) { await response.body?.cancel(); throw new DomainError('unavailable', 'The remote component rejected this action. Check access, session state and connectivity.'); }
      if (!response.body) throw Error('Empty response');
      return JSON.parse(Buffer.from(await readResponseBody(response.body, 1048576)).toString('utf8'));
    });
  } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError('unavailable', 'The remote component is unavailable. Check its address and retry.'); }
}
