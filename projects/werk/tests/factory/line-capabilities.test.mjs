import { testListeningAddress } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HttpLineReader } from '../../src/factory/dist/factory/infrastructure/poller.js';
import { validateOverview } from '../../src/factory/dist/shared/factory.js';
import { validateLineCapabilities } from '../../src/factory/dist/shared/capabilities.js';
const workerCounts = () => ({ total: 1, online: 1, offline: 0, slotsTotal: 2, slotsBusy: 0, slotsAvailable: 2 });
const capabilities = () => ({ schemaVersion: 1, project: 'alpha', execution: 'mock', context: 'unbound', intake: ['structured_task', 'requirement_ref'], providers: ['claude'], profiles: [{ id: 'default', provider: 'claude' }], profilesTruncated: false, capacity: { kind: 'observed', observedAt: new Date().toISOString(), workers: workerCounts() } });
const overview = () => ({ schemaVersion: 1, observedAt: new Date().toISOString(), mode: 'mock', project: 'alpha', tasks: { total: 0, queued: 0, running: 0, simulated: 0, blocked: 0 }, workers: workerCounts(), snapshots: { total: 0, before: 0, after: 0 }, cost: { amountUsd: null, reason: 'unavailable_mock' } });
test('Factory accepts older overviews as unknown capability and preserves only validated new announcements', () => {
  const old = overview(); assert.equal(validateOverview(old).capabilities, null);
  const current = { ...old, capabilities: capabilities() };
  assert.deepEqual(validateOverview(current).capabilities, current.capabilities);
  const mismatch = { ...current, capabilities: { ...current.capabilities, project: 'beta' } };
  assert.throws(() => validateOverview(mismatch), /mismatched/);
});
test('capability validator rejects oversized, inconsistent and unrecognized remote fields', () => {
  const mutations = [
    value => { value.adminToken = 'DO_NOT_FORWARD'; },
    value => { value.capacity.workers.secret = 'DO_NOT_FORWARD'; },
    value => { value.profiles[0].token = 'DO_NOT_FORWARD'; },
    value => { value.execution = 'live'; },
    value => { value.capacity.kind = 'promised'; },
    value => { value.capacity.workers.online = 2; },
    value => { value.intake = ['structured_task', 'pinned_iteration']; },
    value => { value.providers = ['codex']; },
    value => { value.profiles = Array.from({ length: 65 }, (_, index) => ({ id: 'p' + index, provider: 'claude' })); },
    value => { value.profilesTruncated = true; },
    value => { value.capacity.observedAt = 'x'.repeat(41); },
  ];
  for (const mutate of mutations) { const value = capabilities(); mutate(value); assert.throws(() => validateLineCapabilities(value, 'alpha')); }
});
test('real Factory poller retains valid capability DTO, rejects hostile DTO and tolerates legacy absence', async t => {
  // This HTTP fixture deliberately alternates current, hostile and legacy wire payloads.
  /** @type {unknown} */
  let body = { ...overview(), capabilities: capabilities() };
  const token = 'line-private-token-'.repeat(3);
  const server = createServer((request, response) => {
    assert.equal(request.url, '/v1/overview'); assert.equal(request.headers.authorization, 'Bearer ' + token);
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const reader = new HttpLineReader({ WERK_LINE_ALPHA_TOKEN: token }); t.after(() => reader.close());
  const url = 'http://127.0.0.1:' + testListeningAddress(server).port;
  const line = { id: 'alpha', name: 'Alpha', factoryId: 'root', orchestratorUrl: url, webviewUrl: url, tokenEnv: 'WERK_LINE_ALPHA_TOKEN' };
  const current = await reader.read(line); assert.equal(current.status, 'available'); assert.equal(current.overview.capabilities.execution, 'mock');
  body = { ...overview(), capabilities: { ...capabilities(), project: 'beta', adminToken: token } };
  const bad = await reader.read(line); assert.equal(bad.status, 'invalid'); assert.equal(bad.overview, null); assert.ok(!JSON.stringify(bad).includes(token));
  body = overview(); const old = await reader.read(line); assert.equal(old.status, 'available'); assert.equal(old.overview.capabilities, null);
});
