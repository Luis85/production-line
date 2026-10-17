import { DomainError } from '../../shared/errors.js';

/** Shared address policy. Callers retain their raw input limits and error presentation. */
export function validateMcpAddress(value: string): URL {
  let address: URL;
  try { address = new URL(value); }
  catch { throw new DomainError('invalid_input', 'Use an HTTP(S) address without credentials.'); }
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash)
    throw new DomainError('invalid_input', 'Use an HTTP(S) address without credentials, query or fragment; web grants use origins only.');
  const loopback = address.hostname === 'localhost' || address.hostname === '[::1]' || /^127(?:\.[0-9]{1,3}){3}$/.test(address.hostname);
  if (address.protocol === 'http:' && !loopback)
    throw new DomainError('invalid_input', 'Remote MCP connections require HTTPS; HTTP is available only for loopback servers.');
  return address;
}
