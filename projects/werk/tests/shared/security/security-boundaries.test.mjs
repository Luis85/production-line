import { testListeningAddress } from '../../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createFactoryHandler } from '../../../src/factory/dist/factory/http.js';
import { createHttpHandler, tokenAuthorization } from '../../../src/orchestrator/dist/orchestrator/http.js';
import { overviewTotals } from '../../../src/factory/dist/factory/application/overview.js';
import { validateOverview } from '../../../src/factory/dist/shared/factory.js';
import { HttpLineReader } from '../../../src/factory/dist/factory/infrastructure/poller.js';

const token = 'security-boundary-admin-token';
const line = { id: 'alpha', name: 'Alpha', factoryId: 'root', orchestratorUrl: 'http://127.0.0.1', webviewUrl: 'http://127.0.0.1/', tokenEnv: 'WERK_LINE_ALPHA_TOKEN' };
const summary = () => ({ schemaVersion: 1, observedAt: '2026-10-12T00:00:00.000Z', mode: 'mock', project: 'demo', tasks: { total: 0, queued: 0, running: 0, simulated: 0, blocked: 0 }, workers: { total: 0, online: 0, offline: 0, slotsTotal: 0, slotsBusy: 0, slotsAvailable: 0 }, snapshots: { total: 0, before: 0, after: 0 }, cost: { amountUsd: null, reason: 'unavailable_mock' } });
/** @returns {import('../../../src/shared/factory.ts').LineOverview} */
const observed = overview => ({ line, status: 'available', checkedAt: overview.observedAt, error: null, overview: validateOverview(overview) });

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run('http://127.0.0.1:' + testListeningAddress(server).port); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function postWithTypes(url, types) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers: [
      'Host', new URL(url).host, 'Authorization', 'Bearer ' + token,
      ...types.flatMap(type => ['Content-Type', type]), 'Content-Length', '2',
    ] }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

for (const service of ['factory', 'orchestrator']) {
  test(`${service}: duplicate Content-Type headers cannot select conflicting body interpretations`, async () => {
    let writes = 0;
    const create = input => { writes++; return input; };
    const errors = [];
    const application = { createFactory: create, createTask: create };
    const handler = service === 'factory'
      // @ts-expect-error Deliberately instrument only the mutation seam reached by this HTTP boundary test.
      ? createFactoryHandler(application, token, '', error => errors.push(error))
      // @ts-expect-error Deliberately instrument only the mutation seam reached by this HTTP boundary test.
      : createHttpHandler({ application, schemaVersion: 3, authorize: tokenAuthorization(token, 'enrollment-token'), views: { intake: '', concept: '' }, reportError: error => errors.push(error) });
    await withServer(handler, async base => {
      const url = base + (service === 'factory' ? '/v1/factories' : '/v1/tasks');
      for (const types of [['application/json', 'text/plain'], ['text/plain', 'application/json'], ['application/json', 'application/json']]) {
        const response = await postWithTypes(url, types);
        assert.equal(response.status, 400);
        assert.match(response.body.error, /single Content-Type/);
      }
      assert.equal(writes, 0);
      assert.equal((await postWithTypes(url, [])).status, 415);
      assert.equal((await postWithTypes(url, ['application/json; charset=utf-8'])).status, 201);
      assert.equal(writes, 1);
      assert.deepEqual(errors, []);
    });
  });
}

function setCount(overview, group, count) {
  if (group === 'tasks') { overview.tasks.total = count; overview.tasks.queued = count; }
  if (group === 'workers') { overview.workers.total = count; overview.workers.online = count; }
  if (group === 'snapshots') { overview.snapshots.total = count; overview.snapshots.before = count; }
}

test('portfolio sums report overflowing counter groups as unknown while preserving exact groups and line availability', () => {
  for (const group of ['tasks', 'workers', 'snapshots']) {
    const left = summary(), right = summary();
    setCount(left, group, Number.MAX_SAFE_INTEGER);
    setCount(right, group, 2);
    // Each remote summary is valid in isolation; their portfolio sum cannot be represented exactly.
    const totals = overviewTotals([observed(left), observed(right)]);
    assert.equal(totals[group], null, `${group} must not expose a rounded total`);
    for (const other of ['tasks', 'workers', 'snapshots'].filter(name => name !== group)) assert.deepEqual(totals[other], left[other]);
    assert.equal(totals.partial, true);
    assert.equal(totals.lines, 2);
    assert.equal(totals.availableLines, 2);
    assert.equal(totals.unavailableLines, 0);
  }
});

test('portfolio sums preserve the exact safe-integer boundary and empty portfolio semantics', () => {
  for (const group of ['tasks', 'workers', 'snapshots']) {
    const left = summary(), right = summary();
    setCount(left, group, Number.MAX_SAFE_INTEGER - 1);
    setCount(right, group, 1);
    const totals = overviewTotals([observed(left), observed(right)]);
    assert.equal(totals[group].total, Number.MAX_SAFE_INTEGER);
    assert.equal(totals.partial, false);
  }
  const empty = overviewTotals([]);
  assert.equal(empty.tasks, null);
  assert.equal(empty.partial, false);
});

test('Factory polling rejects overlapping busy and available slots but permits offline capacity', async () => {
  let value = summary();
  value.workers = { total: 1, online: 1, offline: 0, slotsTotal: 1, slotsBusy: 1, slotsAvailable: 1 };
  const reader = new HttpLineReader({ [line.tokenEnv]: 'line-token' });
  try {
    await withServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    }, async base => {
      const target = { ...line, orchestratorUrl: base };
      const invalid = await reader.read(target);
      assert.equal(invalid.status, 'invalid');
      assert.equal(invalid.overview, null);
      value = summary();
      value.workers = { total: 2, online: 1, offline: 1, slotsTotal: 8, slotsBusy: 2, slotsAvailable: 2 };
      const valid = await reader.read(target);
      assert.equal(valid.status, 'available');
      assert.deepEqual(valid.overview.workers, value.workers);
    });
  } finally { reader.close(); }
});
