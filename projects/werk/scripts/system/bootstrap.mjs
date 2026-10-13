import { createHash } from 'node:crypto';
import { inputError } from '../runtime/config.mjs';
import { tokenEnv } from './state.mjs';

export async function factoryRequest(url, token, path, { method = 'GET', body, key, signal } = {}) {
  const response = await fetch(new URL(path, url), { method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000),
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 1048576) { await reader.cancel(); throw Error('Factory response exceeded its limit.'); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('Factory returned an invalid response.'); }
  return { status: response.status, value };
}
export async function bootstrapSystem(definition, credentials, { factoryUrl = `http://127.0.0.1:${definition.factory.port}`, internalUrls, signal } = {}) {
  async function ensure(kind, expected) {
    const path = `/v1/${kind}/${encodeURIComponent(expected.id)}`;
    let found = await factoryRequest(factoryUrl, credentials.adminToken, path, { signal });
    if (found.status === 404) {
      const digest = createHash('sha256').update(JSON.stringify({ system: definition.id, kind, expected })).digest('hex');
      const result = await factoryRequest(factoryUrl, credentials.adminToken, `/v1/${kind}`, { method: 'POST', body: expected, key: `system.v1.${digest}`, signal });
      if (![201, 409].includes(result.status)) throw Error('Factory registration failed. Check the saved system configuration.');
      // A durable receipt may replay a previously deleted resource; verify current state.
      found = await factoryRequest(factoryUrl, credentials.adminToken, path, { signal });
    }
    if (found.status !== 200 || Object.entries(expected).some(([key, value]) => found.value[key] !== value)) throw inputError('Factory registry differs from the system definition. Restore its registered resources before restarting; existing resources were preserved.');
  }
  let validateLineCapabilities;
  try { ({ validateLineCapabilities } = await import(new URL('../../src/factory/dist/shared/capabilities.js', import.meta.url))); }
  catch { throw inputError('Packaged line capability validation is missing. Extract a complete matching release.'); }
  // Verify every authenticated line before registry mutation; a healthy wrong project
  // or an older incompatible service cannot silently become this system's line.
  for (const [index, line] of definition.productionLines.entries()) {
    const url = internalUrls?.[index] ?? `http://127.0.0.1:${line.orchestrator.port}`;
    const result = await factoryRequest(url, credentials.credentials[tokenEnv(index)], '/v1/capabilities', { signal });
    if (result.status !== 200) throw inputError('A production line did not provide authenticated capabilities. Verify the complete matching release and line credentials.');
    try { validateLineCapabilities(result.value, line.project); }
    catch { throw inputError('A production line announced incompatible capabilities or a different project. Registration was not changed.'); }
  }
  await ensure('factories', { id: definition.factory.id, name: definition.factory.name, parentId: null });
  for (const factory of definition.factory.subFactories) await ensure('factories', factory);
  for (const [index, line] of definition.productionLines.entries()) await ensure('lines', { id: line.id, name: line.name, factoryId: line.factoryId,
    orchestratorUrl: internalUrls?.[index] ?? `http://127.0.0.1:${line.orchestrator.port}`, webviewUrl: line.orchestrator.webviewUrl ?? `http://127.0.0.1:${line.orchestrator.port}/`, tokenEnv: tokenEnv(index) });
}
