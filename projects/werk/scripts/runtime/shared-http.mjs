import { access } from 'node:fs/promises';

let transport;
async function loadTransport() {
  // A full release has all apps; a copied portable app has only its own distribution.
  // Resolve within the release, never through the caller's project or node_modules.
  for (const kind of ['worker', 'orchestrator', 'factory']) {
    const base = new URL(`../../src/${kind}/dist/shared/http/`, import.meta.url);
    try { await access(new URL('client.js', base)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    return import(new URL('transport.js', base));
  }
  throw Error('Prebuilt HTTP transport is missing. Extract a complete Werk release or portable app.');
}
export async function withOwnedResponse(...args) {
  transport ??= loadTransport();
  return (await transport).withOwnedResponse(...args);
}
